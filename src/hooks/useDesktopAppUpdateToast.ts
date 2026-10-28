import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  checkAppUpdate,
  installAppUpdate,
  isDesktopApp,
} from "@/lib/appUpdater";
import { extractErrorMessage } from "@/utils/errorUtils";

let didCheck = false;

export function useDesktopAppUpdateToast() {
  const { t } = useTranslation();

  useEffect(() => {
    if (didCheck || !isDesktopApp()) return;
    didCheck = true;

    void (async () => {
      try {
        const update = await checkAppUpdate();
        if (!update) return;
        toast.info(
          t("settings.appUpdate.toastTitle", { version: update.version }),
          {
            duration: 20000,
            closeButton: true,
            action: {
              label: t("settings.appUpdate.install"),
              onClick: () => {
                const id = toast.loading(t("settings.appUpdate.downloading"));
                void installAppUpdate(update, (pct) => {
                  toast.loading(
                    pct == null
                      ? t("settings.appUpdate.downloading")
                      : t("settings.appUpdate.downloadingPct", { pct }),
                    { id },
                  );
                })
                  .then(() => {
                    toast.success(t("settings.appUpdate.restarting"), { id });
                  })
                  .catch((error) => {
                    toast.error(t("settings.appUpdate.failed"), {
                      id,
                      description: extractErrorMessage(error) || undefined,
                      closeButton: true,
                    });
                  });
              },
            },
          },
        );
      } catch {
        // Network / unsigned feed — don't nag on every launch.
      }
    })();
  }, [t]);
}
