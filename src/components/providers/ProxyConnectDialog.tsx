import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Copy, Eye, EyeOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import {
  authApi,
  type ManagedAuthProvider,
  type ProviderDirectToken,
} from "@/lib/api/auth";
import type { UpstreamCredential, UpstreamInfo } from "@/lib/upstreamInfo";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ProxyConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerName: string;
  appId: string;
  providerId: string;
  proxyUrl: string;
  upstream: UpstreamInfo;
}

/** 复制代理地址的弹窗：代理（CC Switch）地址 + 上游直连信息（地址 / Key / 模型）。 */
export function ProxyConnectDialog({
  open,
  onOpenChange,
  providerName,
  appId,
  providerId,
  proxyUrl,
  upstream,
}: ProxyConnectDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] gap-2 rounded-[8px] p-2 sm:rounded-[8px]">
        <DialogHeader className="space-y-0 p-0">
          <DialogTitle>
            {t("provider.connect.title", { name: providerName })}
          </DialogTitle>
          <DialogDescription>{t("provider.connect.desc")}</DialogDescription>
        </DialogHeader>

        {/* Header and footer stay put; only the islands scroll on short windows. */}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          <section className="space-y-2 rounded-[8px] border border-border-default p-2">
            <h3 className="text-[12.35px] font-semibold leading-[1.3]">
              {t("provider.connect.proxyTitle")}
            </h3>
            <CopyField
              label={t("provider.connect.proxyUrl")}
              value={proxyUrl}
            />
            <p className="text-[12.35px] leading-[1.3] text-muted-foreground">
              {t("provider.connect.proxyHint")}
            </p>
          </section>

          <section className="space-y-2 rounded-[8px] border border-border-default p-2">
            <h3 className="text-[12.35px] font-semibold leading-[1.3]">
              {t("provider.connect.upstreamTitle")}
            </h3>
            <CopyField
              label={
                upstream.isFullUrl
                  ? t("provider.connect.endpoint")
                  : t("provider.connect.baseUrl")
              }
              value={upstream.baseUrl}
            />
            {!upstream.isFullUrl &&
              upstream.credential.kind !== "managed" &&
              upstream.endpoint &&
              upstream.endpoint !== upstream.baseUrl && (
                <CopyField
                  label={t("provider.connect.fullEndpoint")}
                  value={upstream.endpoint}
                />
              )}
            <CredentialField
              credential={upstream.credential}
              appId={appId}
              providerId={providerId}
              proxyUrl={proxyUrl}
              endpoint={upstream.endpoint}
              isFullUrl={upstream.isFullUrl}
            />
            <CopyField
              label={t("provider.connect.model")}
              value={upstream.model}
            />
          </section>
        </div>

        <DialogFooter className="gap-2 p-0 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AUTH_PROVIDER_LABEL: Record<ManagedAuthProvider, string> = {
  github_copilot: "GitHub Copilot",
  codex_oauth: "ChatGPT (Codex OAuth)",
  xai_oauth: "xAI OAuth",
  agy_oauth: "Antigravity",
  claude_official: "Claude",
};

/** API key row: a static key is copyable; managed OAuth / env / CLI login are explained instead. */
function CredentialField({
  credential,
  appId,
  providerId,
  proxyUrl,
  endpoint,
  isFullUrl,
}: {
  credential: UpstreamCredential;
  appId: string;
  providerId: string;
  proxyUrl: string;
  endpoint: string;
  isFullUrl: boolean;
}) {
  const { t } = useTranslation();
  const label = t("provider.connect.apiKey");

  if (credential.kind === "key") {
    return <CopyField label={label} value={credential.value} secret />;
  }
  if (credential.kind === "env") {
    return (
      <CopyField
        label={t("provider.connect.apiKeyEnv")}
        value={credential.name}
      />
    );
  }
  if (credential.kind === "managed") {
    return (
      <ManagedCredential
        credential={credential}
        label={label}
        appId={appId}
        providerId={providerId}
        proxyUrl={proxyUrl}
        endpoint={endpoint}
        isFullUrl={isFullUrl}
      />
    );
  }
  if (credential.kind === "native") {
    return (
      <InfoField label={label} value={t("provider.connect.nativeLogin")}>
        {t("provider.connect.nativeHint")}
      </InfoField>
    );
  }
  return <CopyField label={label} value="" />;
}

function ManagedCredential({
  credential,
  label,
  appId,
  providerId,
  proxyUrl,
  endpoint,
  isFullUrl,
}: {
  credential: Extract<UpstreamCredential, { kind: "managed" }>;
  label: string;
  appId: string;
  providerId: string;
  proxyUrl: string;
  endpoint: string;
  isFullUrl: boolean;
}) {
  const { t } = useTranslation();
  const { authProvider, accountId } = credential;
  const { data: status } = useQuery({
    queryKey: ["managed-auth-status", authProvider],
    queryFn: () => authApi.authGetStatus(authProvider),
    staleTime: 30_000,
  });
  const targetId = accountId ?? status?.default_account_id ?? null;
  const account = status?.accounts.find((item) => item.id === targetId);
  const providerName = AUTH_PROVIDER_LABEL[authProvider] ?? authProvider;
  const needsReauth =
    account?.requires_reauth === true || account?.reauth_required === true;

  const who = account
    ? accountId
      ? account.login
      : t("provider.connect.defaultAccount", { name: account.login })
    : status
      ? t("provider.connect.noAccount")
      : "…";

  return (
    <>
      <InfoField label={label} value={`${providerName} · ${who}`}>
        {needsReauth && (
          <span className="mb-1 flex items-center gap-1 text-danger-text">
            <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            {t("provider.connect.needsReauth")}
          </span>
        )}
        {t("provider.connect.oauthHint")}
      </InfoField>
      <DirectTokenFields
        appId={appId}
        providerId={providerId}
        proxyUrl={proxyUrl}
        fallbackEndpoint={isFullUrl ? "" : endpoint}
      />
    </>
  );
}

/** Current OAuth access token plus the URL a direct client polls for a fresh one. */
function DirectTokenFields({
  appId,
  providerId,
  proxyUrl,
  fallbackEndpoint,
}: {
  appId: string;
  providerId: string;
  proxyUrl: string;
  /** Shown until the backend answers with the real endpoint (Copilot's depends on the account). */
  fallbackEndpoint: string;
}) {
  const { t } = useTranslation();
  // Local state on purpose: the token must not enter the (persisted) query cache.
  const [token, setToken] = useState<ProviderDirectToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authApi
      .getProviderDirectToken(appId, providerId)
      .then((result) => !cancelled && setToken(result))
      .catch(
        (reason: unknown) =>
          !cancelled &&
          setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      cancelled = true;
    };
  }, [appId, providerId]);

  let tokenUrl = "";
  try {
    tokenUrl = `${new URL(proxyUrl).origin}/auth/token/${encodeURIComponent(appId)}/${encodeURIComponent(providerId)}`;
  } catch {
    // proxyUrl is always absolute; leave the row empty rather than throwing.
  }

  const label = token?.expires_at
    ? t("provider.connect.tokenUntil", {
        time: new Date(token.expires_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      })
    : t("provider.connect.token");

  return (
    <>
      {error ? (
        <InfoField label={t("provider.connect.token")} value={error} />
      ) : token ? (
        <CopyField label={label} value={token.access_token} secret />
      ) : (
        <InfoField label={t("provider.connect.token")} value="…" />
      )}
      {(token?.endpoint || fallbackEndpoint) && (
        <CopyField
          label={t("provider.connect.fullEndpoint")}
          value={token?.endpoint || fallbackEndpoint}
        />
      )}
      {token?.headers?.length ? (
        <div className="space-y-1">
          <CopyField
            label={t("provider.connect.requiredHeaders")}
            value={token.headers
              .map((header) => `${header.name}: ${header.value}`)
              .join("\n")}
            multiline
          />
          <p className="text-[12.35px] leading-[1.3] text-muted-foreground">
            {t("provider.connect.requiredHeadersHint")}
          </p>
        </div>
      ) : null}
      <CopyField label={t("provider.connect.tokenUrl")} value={tokenUrl} />
      <p className="text-[12.35px] leading-[1.3] text-muted-foreground">
        {t("provider.connect.tokenUrlHint")}
      </p>
    </>
  );
}

/** Read-only, non-copyable row (same 24px box as an Input) with an optional hint below. */
function InfoField({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-1">
        <div className="flex h-6 min-w-0 flex-1 items-center rounded-[4px] border border-border-default px-2 text-[12.35px] leading-[1.3] text-foreground">
          <span className="min-w-0 truncate">{value}</span>
        </div>
        {/* Same width as a CopyField's button so the boxes line up. */}
        <span className="h-6 w-6 shrink-0" aria-hidden />
      </div>
      {children && (
        <p className="text-[12.35px] leading-[1.3] text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  );
}

function CopyField({
  label,
  value,
  secret = false,
  multiline = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
  /** One line per row in a read-only textarea (the value may contain newlines). */
  multiline?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const empty = value === "";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void copyText(value)
      .then(() => setCopied(true))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
  };

  const copyLabel = t("provider.connect.copyField", { name: label });

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-1">
        {multiline ? (
          <Textarea
            readOnly
            value={value}
            rows={value.split("\n").length}
            className="min-h-0 min-w-0 flex-1 resize-none whitespace-pre font-mono text-[12.35px] leading-[1.3]"
            onClick={(event) => event.currentTarget.select()}
          />
        ) : (
          <Input
            readOnly
            value={empty ? "" : value}
            placeholder={t("provider.connect.notSet")}
            type={secret && !revealed ? "password" : "text"}
            className="min-w-0 flex-1 font-mono"
            onClick={(event) => event.currentTarget.select()}
          />
        )}
        {secret && !empty && (
          <HoverTip
            content={
              revealed ? t("provider.connect.hide") : t("provider.connect.show")
            }
          >
            <Button
              variant="quiet"
              size="icon-compact"
              aria-label={
                revealed
                  ? t("provider.connect.hide")
                  : t("provider.connect.show")
              }
              onClick={() => setRevealed((prev) => !prev)}
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" strokeWidth={1.5} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.5} />
              )}
            </Button>
          </HoverTip>
        )}
        <HoverTip content={copyLabel}>
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={copyLabel}
            disabled={empty}
            onClick={copy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500" strokeWidth={1.5} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.5} />
            )}
          </Button>
        </HoverTip>
      </div>
    </div>
  );
}
