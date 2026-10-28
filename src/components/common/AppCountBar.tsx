import React, { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { cn } from "@/lib/utils";
import { HoverTip } from "@/components/ui/hover-tip";

interface AppCountBarProps {
  totalLabel: string;
  counts: Partial<Record<AppId, number>>;
  appIds?: AppId[];
  totalCount?: number;
  onToggleAll?: (app: AppId, enabled: boolean) => void | Promise<void>;
  pendingApp?: AppId | null;
  disabled?: boolean;
  trailing?: ReactNode;
}

export const AppCountBar: React.FC<AppCountBarProps> = ({
  totalLabel,
  counts,
  appIds = APP_IDS,
  totalCount,
  onToggleAll,
  pendingApp,
  disabled = false,
  trailing,
}) => {
  const { t } = useTranslation();
  const bulkToggleEnabled = totalCount !== undefined && !!onToggleAll;
  const bulkTotalCount = totalCount ?? 0;
  const hasPendingBulkToggle = pendingApp !== undefined && pendingApp !== null;

  return (
    <div className="mb-2 flex min-w-0 w-full flex-shrink-0 items-center gap-2 overflow-hidden rounded-[8px] border border-border-default px-2 py-2">
      <Badge
        variant="outline"
        className="h-6 shrink-0 whitespace-nowrap border-black/10 bg-black/[0.04] px-2 text-[12.35px] font-medium leading-[1.3] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04]"
      >
        {totalLabel}
      </Badge>
      <div className="app-count-bar-scroll min-w-0 flex-1 overflow-x-auto">
        <div className="ml-auto flex w-max items-center justify-end gap-2">
          {appIds.map((app) => {
            const count = counts[app] ?? 0;
            const allEnabled =
              bulkToggleEnabled &&
              bulkTotalCount > 0 &&
              count >= bulkTotalCount;
            const partiallyEnabled =
              bulkToggleEnabled && count > 0 && count < bulkTotalCount;
            const pending = pendingApp === app;
            const actionLabel = allEnabled
              ? t("common.disableAllForApp", { app: APP_ICON_MAP[app].label })
              : t("common.enableAllForApp", { app: APP_ICON_MAP[app].label });

            if (!bulkToggleEnabled) {
              return (
                <Badge
                  key={app}
                  variant="secondary"
                  className={cn(APP_ICON_MAP[app].badgeClass, "h-6")}
                  title={`${APP_ICON_MAP[app].label}: ${count}`}
                >
                  <span className="sr-only">{APP_ICON_MAP[app].label}:</span>
                  {APP_ICON_MAP[app].icon}
                  <span className="ml-1 font-bold">{count}</span>
                </Badge>
              );
            }

            return (
              <HoverTip key={app} content={actionLabel}>
                <Button
                  type="button"
                  variant="secondary"
                  role="checkbox"
                  aria-checked={partiallyEnabled ? "mixed" : allEnabled}
                  aria-busy={pending}
                  aria-label={actionLabel}
                  data-selection-state={
                    pending
                      ? "pending"
                      : allEnabled
                        ? "all"
                        : partiallyEnabled
                          ? "partial"
                          : "none"
                  }
                  disabled={
                    disabled || bulkTotalCount === 0 || hasPendingBulkToggle
                  }
                  onClick={() => void onToggleAll?.(app, !allEnabled)}
                  className={cn(
                    badgeVariants({ variant: "secondary" }),
                    APP_ICON_MAP[app].badgeClass,
                    "h-6 min-w-0 shrink-0 select-none focus:ring-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
                    pending && "cursor-wait",
                  )}
                >
                  <span className="sr-only">{APP_ICON_MAP[app].label}:</span>
                  {APP_ICON_MAP[app].icon}
                  <span className="ml-1 font-bold">{count}</span>
                </Button>
              </HoverTip>
            );
          })}
        </div>
      </div>
      {trailing ? (
        <div className="flex h-6 shrink-0 items-center">{trailing}</div>
      ) : null}
    </div>
  );
};
