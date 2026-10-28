import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  Layers,
  Plug,
  Route,
  Settings2,
  Shuffle,
} from "lucide-react";
import type { AppMode } from "@/types/proxy";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { HoverTip } from "@/components/ui/hover-tip";
import {
  SegmentThumb,
  useSlidingIndicator,
} from "@/components/ui/sliding-indicator";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const MODE_ICON = { direct: Plug, route: Route, stack: Layers } as const;

/** 模式色用于页头状态、tab、侧栏标签、当前卡片和激活条的 CTA。 */
export const MODE_TONE: Record<
  AppMode,
  { soft: string; text: string; dot: string; border: string }
> = {
  direct: {
    soft: "bg-direct-soft",
    text: "text-direct-text",
    dot: "bg-direct",
    border: "border-direct",
  },
  route: {
    soft: "bg-route-soft",
    text: "text-route-text",
    dot: "bg-route",
    border: "border-route",
  },
  stack: {
    soft: "bg-stack-soft",
    text: "text-stack-text",
    dot: "bg-stack",
    border: "border-stack",
  },
};

interface ModeTabsProps {
  modes: AppMode[];
  active: AppMode;
  view: AppMode;
  onView: (mode: AppMode) => void;
  /** 状态行：「前导 + 值」，空间不够先截前导；值仅在独自超出整栏时才截断 */
  status?: { lead: string; value: string };
  /** Routing endpoint URL, shown with a copy button */
  endpoint?: string;
  failover?: {
    enabled: boolean;
    disabled?: boolean;
    onChange: (enabled: boolean) => void;
  };
  onOpenRouteSettings?: () => void;
  /** Codex 聚合页签上的「聚合设置」（子代理模型、经典子代理） */
  onOpenStackSettings?: () => void;
  /** 供应商搜索框挂在状态行右侧（由列表通过 portal 渲染进来） */
  searchSlotRef?: (node: HTMLDivElement | null) => void;
}

/**
 * 模式行：三段 tab 只负责查看。白底凸起只给正在看的那段；生效的那段只用模式色文字和圆点，
 * 不铺底（否则彩色那格比正在看的更抢眼）。组右边的「?」说明三种模式的区别。
 * 模式 tab 保留文字、不挂提示；右侧的故障转移、路由设置是纯图标 + HoverTip。
 */
export function ModeTabs({
  modes,
  active,
  view,
  onView,
  status,
  endpoint,
  failover,
  onOpenRouteSettings,
  onOpenStackSettings,
  searchSlotRef,
}: ModeTabsProps) {
  const { t } = useTranslation();
  const indicator = useSlidingIndicator<HTMLDivElement>(
    '[aria-pressed="true"]',
    view,
  );

  return (
    <div className="flex min-h-8 shrink-0 items-center gap-2 px-2 pt-2">
      <div
        ref={indicator.ref}
        role="group"
        aria-label={t("mode.tabsLabel")}
        className="relative inline-flex h-6 shrink-0 items-center gap-0 rounded-[4px] bg-subtle p-0.5"
      >
        <SegmentThumb
          rect={indicator.rect}
          animate={indicator.animate}
          className="rounded-[3px]"
        />
        {modes.map((mode) => {
          const Icon = MODE_ICON[mode];
          const isActive = mode === active;
          const selected = mode === view;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={selected}
              onClick={() => onView(mode)}
              className={cn(
                "relative inline-flex h-5 min-w-[60px] items-center justify-center gap-1 rounded-[3px] px-2 text-[12.35px] leading-[1.3] transition-colors duration-150",
                isActive
                  ? MODE_TONE[mode].text
                  : selected
                    ? "text-fg-1"
                    : "text-fg-2 hover:text-fg-1",
                selected || isActive ? "font-semibold" : "font-medium",
              )}
            >
              <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              {t(`mode.names.${mode}`)}
              {isActive && (
                <span
                  aria-label={t("mode.active")}
                  role="img"
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    MODE_TONE[mode].dot,
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
      <HelpTip title={t("mode.help.title")} className="-ms-2">
        {modes.map((mode) => (
          <span key={mode} className="block">
            {t(`mode.help.${mode}`)}
          </span>
        ))}
      </HelpTip>

      {status && (status.lead || status.value) && (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[12.35px] leading-[1.3] text-fg-2">
          {status.lead && <span className="truncate">{status.lead}</span>}
          <span className="max-w-full shrink-0 truncate" title={status.value}>
            {status.value}
          </span>
        </div>
      )}
      {!status && <div className="flex-1" />}
      {searchSlotRef && (
        <div
          ref={searchSlotRef}
          className="flex min-w-0 shrink items-center empty:hidden"
        />
      )}

      {endpoint && <EndpointCopy url={endpoint} />}

      {failover && (
        <HoverTip content={t("mode.failover")}>
          <label className="flex shrink-0 cursor-pointer items-center gap-1">
            <Shuffle
              className="h-4 w-4 text-fg-2"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <Switch
              checked={failover.enabled}
              disabled={failover.disabled}
              onCheckedChange={failover.onChange}
              aria-label={t("mode.failover")}
            />
          </label>
        </HoverTip>
      )}
      {onOpenRouteSettings && (
        <HoverTip content={t("mode.routeSettings")}>
          <Button
            variant="quiet"
            size="icon"
            className="shrink-0"
            aria-label={t("mode.routeSettings")}
            onClick={onOpenRouteSettings}
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </HoverTip>
      )}
      {onOpenStackSettings && (
        <HoverTip content={t("mode.stackSettings.title")}>
          <Button
            variant="quiet"
            size="compact"
            className="h-8 w-8 shrink-0 px-0"
            aria-label={t("mode.stackSettings.title")}
            onClick={onOpenStackSettings}
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </HoverTip>
      )}
    </div>
  );
}

/** Read-only endpoint URL + copy button. Truncates before it pushes the controls off the row. */
function EndpointCopy({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void copyText(url)
      .then(() => setCopied(true))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
  };

  const label = t("mode.copyEndpoint");
  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      <span
        className="min-w-0 truncate font-mono text-[12.35px] leading-[1.3] text-fg-2"
        title={url}
      >
        {url}
      </span>
      <HoverTip content={label}>
        <Button
          variant="quiet"
          size="icon-compact"
          className="shrink-0"
          aria-label={label}
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
  );
}
