import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import { extractUpstreamInfo } from "@/lib/upstreamInfo";

const provider = (
  settingsConfig: unknown,
  extra: Partial<Provider> = {},
): Provider => ({
  id: "p1",
  name: "p1",
  settingsConfig: settingsConfig as Provider["settingsConfig"],
  ...extra,
});

describe("extractUpstreamInfo", () => {
  it("reads claude env values", () => {
    expect(
      extractUpstreamInfo(
        "claude",
        provider({
          env: {
            ANTHROPIC_BASE_URL: "https://api.example.com",
            ANTHROPIC_AUTH_TOKEN: "sk-claude",
            ANTHROPIC_MODEL: "claude-sonnet",
          },
        }),
      ),
    ).toEqual({
      baseUrl: "https://api.example.com",
      endpoint: "https://api.example.com/v1/messages",
      isFullUrl: false,
      credential: { kind: "key", value: "sk-claude" },
      model: "claude-sonnet",
    });
  });

  it("strips the local [1M] marker and flags Full URL mode", () => {
    const info = extractUpstreamInfo(
      "claude",
      provider(
        {
          env: {
            ANTHROPIC_BASE_URL: "https://x.example.com/v1/messages",
            ANTHROPIC_MODEL: "claude-opus-4-8[1M]",
          },
        },
        { meta: { isFullUrl: true } },
      ),
    );
    expect(info.model).toBe("claude-opus-4-8");
    expect(info.isFullUrl).toBe(true);
  });

  it("reads codex auth + toml", () => {
    const config = [
      'model_provider = "custom"',
      'model = "gpt-5"',
      "",
      "[model_providers.custom]",
      'base_url = "https://codex.example.com/v1"',
    ].join("\n");
    expect(
      extractUpstreamInfo(
        "codex",
        provider({ auth: { OPENAI_API_KEY: "sk-codex" }, config }),
      ),
    ).toMatchObject({
      baseUrl: "https://codex.example.com/v1",
      credential: { kind: "key", value: "sk-codex" },
      model: "gpt-5",
    });
  });

  it("reads gemini env values", () => {
    expect(
      extractUpstreamInfo(
        "gemini",
        provider({
          env: {
            GOOGLE_GEMINI_BASE_URL: "https://g.example.com",
            GEMINI_API_KEY: "gk",
            GEMINI_MODEL: "gemini-pro",
          },
        }),
      ),
    ).toMatchObject({
      baseUrl: "https://g.example.com",
      credential: { kind: "key", value: "gk" },
      model: "gemini-pro",
    });
  });

  it("reports a managed OAuth account instead of an empty key", () => {
    const config = [
      "[models]",
      'default = "grok"',
      "[model.grok]",
      'model = "grok-4.7[1M]"',
      'base_url = "https://api.x.ai/v1"',
      'name = "xAI"',
    ].join("\n");
    const info = extractUpstreamInfo(
      "grokbuild",
      provider(
        { config },
        {
          meta: {
            providerType: "xai_oauth",
            authBinding: {
              source: "managed_account",
              authProvider: "xai_oauth",
              accountId: "acc-1",
            },
          },
        },
      ),
    );
    expect(info.credential).toEqual({
      kind: "managed",
      authProvider: "xai_oauth",
      accountId: "acc-1",
    });
    expect(info.baseUrl).toBe("https://api.x.ai/v1");
    expect(info.model).toBe("grok-4.7");
  });

  it("falls back to the default account when an OAuth provider is unbound", () => {
    expect(
      extractUpstreamInfo(
        "claude",
        provider({ env: {} }, { meta: { providerType: "codex_oauth" } }),
      ).credential,
    ).toEqual({
      kind: "managed",
      authProvider: "codex_oauth",
      accountId: null,
    });
  });

  it("surfaces the Grok Build env_key", () => {
    const config = [
      "[models]",
      'default = "g"',
      "[model.g]",
      'model = "grok-4.5"',
      'base_url = "https://api.example.com"',
      'env_key = "MY_GROK_KEY"',
    ].join("\n");
    expect(
      extractUpstreamInfo("grokbuild", provider({ config })).credential,
    ).toEqual({ kind: "env", name: "MY_GROK_KEY" });
  });

  it("returns an empty result for missing config", () => {
    expect(extractUpstreamInfo("claude", provider(undefined))).toEqual({
      baseUrl: "",
      endpoint: "",
      isFullUrl: false,
      credential: { kind: "none" },
      model: "",
    });
  });

  describe("endpoint", () => {
    const claude = (baseUrl: string, meta?: Provider["meta"]) =>
      extractUpstreamInfo(
        "claude",
        provider({ env: { ANTHROPIC_BASE_URL: baseUrl } }, { meta }),
      ).endpoint;

    it("adds the Claude path for the stored API format without doubling /v1", () => {
      expect(claude("https://h.example")).toBe("https://h.example/v1/messages");
      expect(claude("https://h.example/v1/")).toBe(
        "https://h.example/v1/messages",
      );
      expect(claude("https://h.example/v1", { apiFormat: "openai_chat" })).toBe(
        "https://h.example/v1/chat/completions",
      );
      expect(
        claude("https://h.example", { apiFormat: "openai_responses" }),
      ).toBe("https://h.example/v1/responses");
    });

    it("keeps a Full URL as is", () => {
      expect(
        claude("https://h.example/custom/x", { isFullUrl: true } as never),
      ).toBe("https://h.example/custom/x");
    });

    it("follows the Codex wire_api and the proxy's /v1 rule", () => {
      const codex = (baseUrl: string, wire: string) =>
        extractUpstreamInfo(
          "codex",
          provider({
            auth: { OPENAI_API_KEY: "k" },
            config: `model_provider = "x"
[model_providers.x]
base_url = "${baseUrl}"
wire_api = "${wire}"
`,
          }),
        ).endpoint;
      expect(codex("https://h.example", "responses")).toBe(
        "https://h.example/v1/responses",
      );
      expect(codex("https://h.example/v1", "chat")).toBe(
        "https://h.example/v1/chat/completions",
      );
      expect(codex("https://h.example/openai", "responses")).toBe(
        "https://h.example/openai/responses",
      );
    });

    it("uses the fixed endpoint of a managed OAuth account", () => {
      expect(
        extractUpstreamInfo(
          "claude",
          provider(
            { env: { ANTHROPIC_BASE_URL: "https://x.ai/grok" } },
            { meta: { providerType: "xai_oauth" } as never },
          ),
        ).endpoint,
      ).toBe("https://api.x.ai/v1/responses");
    });

    it("builds the Gemini generateContent path with the model", () => {
      expect(
        extractUpstreamInfo(
          "gemini",
          provider({
            env: {
              GOOGLE_GEMINI_BASE_URL: "https://g.example",
              GEMINI_MODEL: "gemini-2.5-pro",
            },
          }),
        ).endpoint,
      ).toBe("https://g.example/v1beta/models/gemini-2.5-pro:generateContent");
    });
  });
});
