import React from "react";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { Button } from "@/components/ui/button";

interface AppToggleGroupProps {
  apps: Partial<Record<AppId, boolean>>;
  onToggle: (app: AppId, enabled: boolean) => void;
  appIds?: AppId[];
  disabled?: boolean;
}

export const AppToggleGroup: React.FC<AppToggleGroupProps> = ({
  apps,
  onToggle,
  appIds = APP_IDS,
  disabled = false,
}) => {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {appIds.map((app) => {
        const { label, icon, activeClass } = APP_ICON_MAP[app];
        const enabled = apps[app];
        return (
          <Button
            key={app}
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onToggle(app, !enabled)}
            disabled={disabled}
            aria-label={label}
            aria-pressed={Boolean(enabled)}
            title={`${label}${enabled ? " ✓" : ""}`}
            className={enabled ? activeClass : "opacity-70 hover:opacity-90"}
          >
            {icon}
          </Button>
        );
      })}
    </div>
  );
};
