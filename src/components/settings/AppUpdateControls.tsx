import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  checkAppUpdate,
  installAppUpdate,
  isDesktopApp,
  type AppUpdateInfo,
} from "@/lib/appUpdater";
import { extractErrorMessage } from "@/utils/errorUtils";

type Status = "idle" | "checking" | "upToDate" | "available" | "installing";

export function AppUpdateControls() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("idle");
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runCheck = useCallback(
    async (opts?: { silent?: boolean }) => {
      setStatus("checking");
      if (!opts?.silent) setError(null);
      try {
        const next = await checkAppUpdate();
        setUpdate(next);
        setStatus(next ? "available" : "upToDate");
        setError(null);
      } catch (err) {
        setUpdate(null);
        setStatus("idle");
        if (!opts?.silent) {
          setError(extractErrorMessage(err) || t("settings.appUpdate.failed"));
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (!isDesktopApp()) return;
    void runCheck({ silent: true });
  }, [runCheck]);

  const runInstall = useCallback(async () => {
    if (!update) return;
    setConfirmOpen(false);
    setStatus("installing");
    setPercent(null);
    setError(null);
    try {
      await installAppUpdate(update, setPercent);
    } catch (err) {
      setStatus("available");
      setError(extractErrorMessage(err) || t("settings.appUpdate.failed"));
    }
  }, [t, update]);

  if (!isDesktopApp()) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {status === "checking" && (
          <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("settings.appUpdate.checking")}
          </span>
        )}
        {status === "upToDate" && (
          <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            {t("settings.appUpdate.upToDate")}
          </span>
        )}
        {status === "available" && update && (
          <span className="inline-flex h-4 min-w-[32px] items-center rounded-[3px] border border-yellow-500/20 bg-yellow-500/10 px-1 text-ui leading-[1.3] text-yellow-600 dark:text-yellow-400">
            {t("settings.appUpdate.available", { version: update.version })}
          </span>
        )}
        {status === "installing" && (
          <span className="inline-flex items-center gap-1 text-ui text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {percent == null
              ? t("settings.appUpdate.downloading")
              : t("settings.appUpdate.downloadingPct", { pct: percent })}
          </span>
        )}
        {status === "available" ? (
          <Button onClick={() => setConfirmOpen(true)}>
            <ArrowUpCircle className="h-4 w-4" />
            {t("settings.appUpdate.install")}
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => void runCheck()}
            disabled={status === "checking" || status === "installing"}
          >
            {status === "checking" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("settings.appUpdate.check")}
          </Button>
        )}
      </div>
      {error && (
        <p className="text-ui text-destructive" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        isOpen={confirmOpen}
        title={t("settings.appUpdate.confirmTitle")}
        message={t("settings.appUpdate.confirmBody", {
          version: update?.version ?? "",
        })}
        confirmText={t("settings.appUpdate.install")}
        variant="info"
        pending={status === "installing"}
        onConfirm={() => void runInstall()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
