import type { Provider } from "@/types";
import type { ManagedAuthProvider } from "@/lib/api/auth";
import { resolveManagedAccountId } from "@/lib/authBinding";
import { isOAuthProviderType } from "@/config/constants";
import { stripClaudeOneMMarker } from "@/components/providers/forms/hooks/useModelState";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";
import {
  codexApiFormatFromWireApi,
  extractCodexExperimentalBearerToken,
  extractCodexModelName,
  extractCodexWireApi,
  getApiKeyFromConfig,
  getCodexBaseUrl,
} from "@/utils/providerConfigUtils";
import { parseGrokBuildConfig } from "@/utils/grokBuildConfig";

/** How the upstream is authenticated, as far as a direct client is concerned. */
export type UpstreamCredential =
  /** Static key stored on the provider: a direct client can use it as is. */
  | { kind: "key"; value: string }
  /** Grok Build reads the key from an environment variable. */
  | { kind: "env"; name: string }
  /** OAuth account held by CC Switch; the proxy injects the token per request. */
  | {
      kind: "managed";
      authProvider: ManagedAuthProvider;
      /** Null: no binding, the proxy falls back to the default account. */
      accountId: string | null;
    }
  /** Codex CLI's own ChatGPT login; nothing is stored here. */
  | { kind: "native" }
  | { kind: "none" };

export interface UpstreamInfo {
  baseUrl: string;
  /** Full URL a direct client POSTs to (base + the protocol's path), as the proxy builds it. */
  endpoint: string;
  /** `baseUrl` is a complete endpoint (Full URL mode), not a prefix. */
  isFullUrl: boolean;
  credential: UpstreamCredential;
  model: string;
}

type ProviderLike = Pick<
  Provider,
  "id" | "category" | "meta" | "settingsConfig"
>;

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** The local 1M-context marker is not part of the real model id (the proxy strips it). */
const cleanModel = (value: unknown): string =>
  stripClaudeOneMMarker(str(value)).trim();

function resolveCredential(
  appId: string,
  provider: ProviderLike,
  staticKey: string,
  envKey: string,
): UpstreamCredential {
  const meta = provider.meta;
  const bound = meta?.authBinding;
  const authProvider =
    bound?.source === "managed_account" && bound.authProvider
      ? bound.authProvider
      : isOAuthProviderType(meta?.providerType)
        ? meta?.providerType
        : undefined;
  if (authProvider) {
    return {
      kind: "managed",
      authProvider: authProvider as ManagedAuthProvider,
      accountId: resolveManagedAccountId(meta, authProvider)?.trim() || null,
    };
  }
  if (staticKey) return { kind: "key", value: staticKey };
  if (envKey) return { kind: "env", name: envKey };
  if (resolveCodexOfficialIdentity(appId as never, provider) === "native_login")
    return { kind: "native" };
  return { kind: "none" };
}

type WireFormat = "anthropic" | "openai_chat" | "openai_responses";

const WIRE_FORMATS: readonly string[] = [
  "anthropic",
  "openai_chat",
  "openai_responses",
];

/** Joins like the proxy adapters: `/v1` is never doubled (`.../v1` + `/v1/x` -> `.../v1/x`). */
function joinPath(base: string, path: string, versions: string[]): string {
  let url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  for (const version of versions) {
    while (url.includes(`${version}${version}`)) {
      url = url.replace(`${version}${version}`, version);
    }
  }
  return url;
}

const CLAUDE_PATH: Record<WireFormat, string> = {
  anthropic: "/v1/messages",
  openai_chat: "/v1/chat/completions",
  openai_responses: "/v1/responses",
};

const OPENAI_PATH: Record<WireFormat, string> = {
  openai_responses: "/responses",
  openai_chat: "/chat/completions",
  anthropic: "/v1/messages",
};

/** Mirrors `codex.rs` `build_url`: a bare origin gets `/v1`, a custom prefix is kept as is. */
function joinOpenAiStyle(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const originOnly = !/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(trimmed);
  const prefixed =
    !trimmed.endsWith("/v1") && originOnly ? `${trimmed}/v1` : trimmed;
  return joinPath(prefixed, path, ["/v1"]);
}

const OAUTH_ENDPOINT: Record<ManagedAuthProvider, string> = {
  xai_oauth: "https://api.x.ai/v1/responses",
  codex_oauth: "https://chatgpt.com/backend-api/codex/responses",
  github_copilot: "https://api.githubcopilot.com/chat/completions",
  agy_oauth: "",
  claude_official: "",
};

const asWireFormat = (value: unknown, fallback: WireFormat): WireFormat =>
  typeof value === "string" && WIRE_FORMATS.includes(value)
    ? (value as WireFormat)
    : fallback;

/** The URL the upstream actually receives, so a client that can't use a base URL can call it directly. */
function resolveEndpoint(
  appId: string,
  provider: ProviderLike,
  baseUrl: string,
  model: string,
  codexWireApi: string | undefined,
  credential: UpstreamCredential,
): string {
  if (credential.kind === "managed") {
    // The proxy ignores the stored base URL for these accounts.
    return OAUTH_ENDPOINT[credential.authProvider] ?? "";
  }
  if (!baseUrl) return "";
  if (provider.meta?.isFullUrl === true) return baseUrl;

  const metaFormat = provider.meta?.apiFormat;
  if (appId === "codex" || appId === "grokbuild") {
    const format = asWireFormat(
      metaFormat ?? codexApiFormatFromWireApi(codexWireApi),
      "openai_responses",
    );
    return joinOpenAiStyle(baseUrl, OPENAI_PATH[format]);
  }
  if (appId === "gemini") {
    return joinPath(
      baseUrl,
      `/v1beta/models/${model || "{model}"}:generateContent`,
      ["/v1beta", "/v1"],
    );
  }
  if (metaFormat === "gemini_native") {
    return joinPath(
      baseUrl,
      `/v1beta/models/${model || "{model}"}:generateContent`,
      ["/v1beta", "/v1"],
    );
  }
  return joinPath(baseUrl, CLAUDE_PATH[asWireFormat(metaFormat, "anthropic")], [
    "/v1",
  ]);
}

/** Direct-connect values (base URL, credential, model) stored on a saved provider. */
export function extractUpstreamInfo(
  appId: string,
  provider: ProviderLike,
): UpstreamInfo {
  const info = extractRawUpstreamInfo(appId, provider);
  const settings = provider.settingsConfig as Record<string, any> | undefined;
  const toml = typeof settings?.config === "string" ? settings.config : "";
  return {
    ...info,
    endpoint: resolveEndpoint(
      appId,
      provider,
      info.baseUrl,
      info.model,
      extractCodexWireApi(toml),
      info.credential,
    ),
  };
}

function extractRawUpstreamInfo(
  appId: string,
  provider: ProviderLike,
): Omit<UpstreamInfo, "endpoint"> {
  const settingsConfig = provider.settingsConfig;
  const config =
    settingsConfig && typeof settingsConfig === "object"
      ? (settingsConfig as Record<string, any>)
      : {};
  const env = (config.env ?? {}) as Record<string, unknown>;
  const isFullUrl = provider.meta?.isFullUrl === true;

  if (appId === "codex") {
    const toml = typeof config.config === "string" ? config.config : "";
    const apiKey =
      str(config.auth?.OPENAI_API_KEY) ||
      str(extractCodexExperimentalBearerToken(toml));
    return {
      baseUrl: str(getCodexBaseUrl({ settingsConfig: config })),
      isFullUrl,
      credential: resolveCredential(appId, provider, apiKey, ""),
      model: cleanModel(extractCodexModelName(toml)),
    };
  }

  if (appId === "grokbuild") {
    const grok = parseGrokBuildConfig(
      typeof config.config === "string" ? config.config : "",
    );
    return {
      baseUrl: str(grok.baseUrl),
      isFullUrl,
      credential: resolveCredential(
        appId,
        provider,
        str(grok.apiKey),
        str(grok.envKey),
      ),
      model: cleanModel(grok.upstreamModel ?? grok.model),
    };
  }

  if (appId === "gemini") {
    return {
      baseUrl: str(env.GOOGLE_GEMINI_BASE_URL),
      isFullUrl,
      credential: resolveCredential(
        appId,
        provider,
        str(env.GEMINI_API_KEY),
        "",
      ),
      model: cleanModel(env.GEMINI_MODEL),
    };
  }

  // claude / claude-desktop
  return {
    baseUrl: str(env.ANTHROPIC_BASE_URL),
    isFullUrl,
    credential: resolveCredential(
      appId,
      provider,
      str(getApiKeyFromConfig(JSON.stringify(config), appId)),
      "",
    ),
    model: cleanModel(env.ANTHROPIC_MODEL),
  };
}
