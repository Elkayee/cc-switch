import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Monitor, MoreHorizontal, Terminal } from "lucide-react";
import { APP_IDS } from "@/config/appConfig";
import { Button } from "@/components/ui/button";

const APP_BADGE_ICON: Partial<
  Record<AppId, { icon: typeof Terminal; offsetY?: number }>
> = {
  claude: { icon: Terminal },
  "claude-desktop": { icon: Monitor, offsetY: 0.5 },
};

interface AppSwitcherProps {
  activeApp: AppId;
  onSwitch: (app: AppId) => void;
  visibleApps?: VisibleApps;
  /** Width needed to show every app with no overflow menu (for header layout budgeting). */
  onFullWidthChange?: (width: number) => void;
}

const STORAGE_KEY = "cc-switch-last-app";

const APP_ICON_NAME: Record<AppId, string> = {
  claude: "claude",
  "claude-desktop": "claude",
  codex: "openai",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
  mcode: "minimax",
};

const APP_DISPLAY_NAME: Record<AppId, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini",
  grokbuild: "Grok Build",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax Code",
};

// 单色图标经 currentColor 继承按钮的 muted 文字色，未选中时自然变灰；
// 其余为固定品牌色，需要显式去色才能和选中态区分
const CURRENT_COLOR_APPS = new Set<AppId>(["codex", "grokbuild", "pi"]);

/** 应用图标 + 角标（Claude Code / Desktop 用角标区分终端与桌面） */
function AppGlyph({ app, isActive }: { app: AppId; isActive: boolean }) {
  const badgeConfig = APP_BADGE_ICON[app];
  const BadgeIcon = badgeConfig?.icon;
  return (
    <span className="relative inline-flex shrink-0">
      <ProviderIcon
        icon={APP_ICON_NAME[app]}
        name={APP_DISPLAY_NAME[app]}
        size={20}
        className={cn(
          "[&>svg]:h-full [&>svg]:w-full",
          !isActive &&
            !CURRENT_COLOR_APPS.has(app) &&
            "grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100",
        )}
      />
      {BadgeIcon && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-[3px] border h-3 w-3",
            isActive
              ? "bg-background border-border text-foreground"
              : "bg-muted border-background text-muted-foreground group-hover:bg-background group-hover:text-foreground",
          )}
          aria-hidden="true"
        >
          <BadgeIcon
            className="h-[8px] w-[8px]"
            strokeWidth={2.5}
            style={
              badgeConfig?.offsetY
                ? { transform: `translateY(${badgeConfig.offsetY}px)` }
                : undefined
            }
          />
        </span>
      )}
    </span>
  );
}

export function AppSwitcher({
  activeApp,
  onSwitch,
  visibleApps,
  onFullWidthChange,
}: AppSwitcherProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const handleSwitch = (app: AppId) => {
    // Re-clicking the active app is allowed: from a non-provider page it returns to the provider list
    localStorage.setItem(STORAGE_KEY, app);
    onSwitch(app);
  };

  // Filter apps based on visibility settings (default all visible)
  const appsToShow = APP_IDS.filter((app) => {
    if (!visibleApps) return true;
    return visibleApps[app];
  });
  const appCount = appsToShow.length;

  const [visibleCount, setVisibleCount] = useState(appCount);

  // 宽度必须取父弹性槽而非自身：自身宽度随可见数量变化，
  // 用它做输入会形成收起→变窄→再收起的反馈循环
  useLayoutEffect(() => {
    const root = rootRef.current;
    const slot = root?.parentElement;
    if (!root || !slot) return;

    const compute = () => {
      const sample = root.querySelector("button");
      if (!sample) return;
      const itemWidth = sample.offsetWidth;
      // jsdom 或未完成布局时 offsetWidth 为 0，保持全部可见
      if (itemWidth <= 0) return;
      const rootStyle = window.getComputedStyle(root);
      const gap = parseFloat(rootStyle.columnGap) || 0;
      const padding =
        (parseFloat(rootStyle.paddingLeft) || 0) +
        (parseFloat(rootStyle.paddingRight) || 0);
      const available = slot.clientWidth;
      const rowWidth = (buttonCount: number) => {
        if (buttonCount <= 0) return padding;
        return padding + buttonCount * itemWidth + (buttonCount - 1) * gap;
      };
      onFullWidthChange?.(rowWidth(appCount));
      if (rowWidth(appCount) <= available) {
        setVisibleCount(appCount);
        return;
      }
      // Need the more button. Total buttons = visible apps + 1.
      // visible can be 0 — only the ⋯ menu — so the island never clips.
      let visible = appCount - 1;
      while (visible >= 0 && rowWidth(visible + 1) > available) {
        visible -= 1;
      }
      setVisibleCount(Math.max(0, visible));
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [appCount, onFullWidthChange]);

  const visibleList = appsToShow.slice(0, Math.max(0, visibleCount));
  // 激活应用被收进溢出区时，顶替最后一个可见位，保证始终可点亮
  if (
    visibleList.length > 0 &&
    appsToShow.includes(activeApp) &&
    !visibleList.includes(activeApp)
  ) {
    visibleList[visibleList.length - 1] = activeApp;
  }
  const overflowList = appsToShow.filter((app) => !visibleList.includes(app));

  return (
    <div
      ref={rootRef}
      className="inline-flex bg-muted rounded-[8px] p-1 gap-1"
      style={{ WebkitAppRegion: "no-drag" } as any}
    >
      {visibleList.map((app) => {
        const isActive = activeApp === app;
        return (
          <Button
            key={app}
            type="button"
            variant="ghost"
            onClick={() => handleSwitch(app)}
            title={APP_DISPLAY_NAME[app]}
            aria-label={APP_DISPLAY_NAME[app]}
            className={cn(
              "h-7 min-w-0 shrink-0 rounded-[8px] px-2",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50",
            )}
          >
            <AppGlyph app={app} isActive={isActive} />
          </Button>
        );
      })}
      {overflowList.length > 0 && (
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              title={t("appSwitcher.more")}
              aria-label={t("appSwitcher.more")}
              className={cn(
                "h-7 min-w-0 shrink-0 rounded-[8px] px-2",
                moreOpen
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50",
              )}
            >
              <MoreHorizontal size={20} className="shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-[100] w-56 p-1"
          >
            {overflowList.map((app) => (
              <Button
                key={app}
                type="button"
                variant="ghost"
                onClick={() => {
                  setMoreOpen(false);
                  handleSwitch(app);
                }}
                className="w-full justify-start"
              >
                <AppGlyph app={app} isActive={false} />
                <span className="truncate">{APP_DISPLAY_NAME[app]}</span>
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
