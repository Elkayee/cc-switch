import React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import {
  isWindows,
  isLinux,
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
} from "@/lib/platform";
import { isTextEditableTarget } from "@/utils/domUtils";
import { useUnsavedChangesTracker } from "@/lib/unsavedChanges";
import { cn } from "@/lib/utils";

interface FullScreenPanelProps {
  isOpen: boolean;
  title: string;
  /** 标题后的灰字（应用名） */
  subtitle?: React.ReactNode;
  /** 返回按钮的读屏文字，默认「返回」 */
  backLabel?: string;
  /** 页头右侧 */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Defaults to no motion to avoid revealing the underlying page during panel transitions. */
  motionPreset?: "none" | "slide-from-right";
  /**
   * 覆盖内容区滚动容器的内边距/间距类。默认 `px-2 py-2 space-y-2`。
   * 通过 `cn`(twMerge) 合并，传入如 `pt-3` 只覆盖顶部内边距，其余保持默认。
   */
  contentClassName?: string;
  /**
   * 编辑表单：用户改过内容后，从侧栏、托盘、⌘, 离开当前页前会先确认。
   * 只给编辑页打开；授权中心、测速这类页面不需要。
   */
  trackUnsavedChanges?: boolean;
}

const DRAG_BAR_HEIGHT = isWindows() || isLinux() ? 0 : 28; // px - match App.tsx
const HEADER_HEIGHT = 48; // px - match App.tsx (UI.md toolbar)

/** Shell content area (App's <main id="content-area">): when present, sub-pages cover only it */
const CONTENT_AREA_ID = "content-area";

let bodyScrollLockCount = 0;
let bodyOverflowBeforeFirstLock: string | null = null;

const lockBodyScroll = () => {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeFirstLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
};

const unlockBodyScroll = () => {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount === 0) {
    document.body.style.overflow = bodyOverflowBeforeFirstLock ?? "";
    bodyOverflowBeforeFirstLock = null;
  }
};

/**
 * 打开着的面板，后打开的在最后。二级页里再开二级页（定价 → 编辑定价、编辑供应商 → 测速）时
 * 每层都在 window 上挂了 ESC 监听，stopPropagation 拦不住同一目标上的其他监听，
 * 所以只让栈顶那层响应，一次 ESC 只退一层。
 */
const openPanelStack: object[] = [];

/**
 * Reusable full-screen panel component
 * Handles portal rendering, header with back button, and footer
 * Uses solid theme colors without transparency
 */
export const FullScreenPanel: React.FC<FullScreenPanelProps> = ({
  isOpen,
  title,
  subtitle,
  backLabel,
  actions,
  onClose,
  children,
  footer,
  contentClassName,
  motionPreset = "none",
  trackUnsavedChanges = false,
}) => {
  // 面板关掉后组件可能还挂着：只在打开时登记，关掉即撤销
  const unsavedChangesHandlers = useUnsavedChangesTracker(
    trackUnsavedChanges && isOpen,
  );
  const { t } = useTranslation();
  const windowControls = React.useContext(WindowControlsContext);
  const prefersReducedMotion = useReducedMotion();
  const disableMotion = motionPreset === "none" || prefersReducedMotion;
  const shouldSlideFromRight =
    motionPreset === "slide-from-right" && !prefersReducedMotion;

  React.useEffect(() => {
    if (!isOpen) return;

    lockBodyScroll();
    return unlockBodyScroll;
  }, [isOpen]);

  // ESC 键关闭面板
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!isOpen) return;

    const entry = {};
    openPanelStack.push(entry);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 上面还叠着别的面板：交给最上面那层
        if (openPanelStack[openPanelStack.length - 1] !== entry) {
          return;
        }

        // 子组件（例如 Radix 的 Select/Dialog/Dropdown）如果已经消费了 ESC，就不要再关闭整个面板
        if (event.defaultPrevented) {
          return;
        }

        if (isTextEditableTarget(event.target)) {
          return; // 让输入框自己处理 ESC（比如清空、失焦等）
        }

        event.stopPropagation(); // 阻止事件继续冒泡到 window，避免触发 App.tsx 的全局监听
        onCloseRef.current();
      }
    };

    // 使用冒泡阶段监听，让子组件（如 Radix UI）优先处理 ESC
    window.addEventListener("keydown", handleKeyDown, false);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, false);
      const index = openPanelStack.indexOf(entry);
      if (index >= 0) openPanelStack.splice(index, 1);
    };
  }, [isOpen]);

  const host =
    typeof document !== "undefined"
      ? document.getElementById(CONTENT_AREA_ID)
      : null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={
            disableMotion
              ? false
              : shouldSlideFromRight
                ? { x: "100%" }
                : { opacity: 0 }
          }
          animate={shouldSlideFromRight ? { x: 0 } : { opacity: 1 }}
          exit={
            disableMotion
              ? { opacity: 1 }
              : shouldSlideFromRight
                ? { x: "100%" }
                : { opacity: 0 }
          }
          transition={
            shouldSlideFromRight
              ? { duration: 0.26, ease: [0.22, 1, 0.36, 1] }
              : { duration: disableMotion ? 0 : 0.2 }
          }
          className={cn(
            "inset-0 z-[60] flex flex-col bg-background",
            host ? "absolute" : "fixed",
          )}
        >
          {/* Drag region - match App.tsx. Linux/Windows: DRAG_BAR_HEIGHT=0, skipped;
              macOS keeps the 28px drag placeholder. */}
          {DRAG_BAR_HEIGHT > 0 && (
            <div
              data-tauri-drag-region
              style={
                {
                  WebkitAppRegion: "drag",
                  height: DRAG_BAR_HEIGHT,
                } as React.CSSProperties
              }
            />
          )}

          {/* Header - match App.tsx */}
          <div
            className="flex-shrink-0 flex items-center"
            {...DRAG_REGION_ATTR}
            style={
              {
                ...DRAG_REGION_STYLE,
                backgroundColor: "hsl(var(--background))",
                height: HEADER_HEIGHT,
              } as React.CSSProperties
            }
          >
            <div
              className="px-2 w-full flex items-center gap-2"
              {...DRAG_REGION_ATTR}
              style={{ ...DRAG_REGION_STYLE } as React.CSSProperties}
            >
              {/* Title area: takes the remaining width, drag region, truncates long titles */}
              <div
                {...DRAG_REGION_ATTR}
                className="flex min-w-0 flex-1 items-center gap-2"
              >
                <HoverTip content={backLabel ?? t("common.back")}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={onClose}
                    aria-label={backLabel ?? t("common.back")}
                    className="rounded-[3px] select-none"
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </HoverTip>
                <h2
                  {...DRAG_REGION_ATTR}
                  className="min-w-0 truncate text-[12.35px] leading-[1.3] font-semibold text-foreground select-none"
                >
                  {title}
                </h2>
                {subtitle ? (
                  <span
                    {...DRAG_REGION_ATTR}
                    className="whitespace-nowrap text-[12.35px] leading-[1.3] text-muted-foreground select-none"
                  >
                    {subtitle}
                  </span>
                ) : null}
              </div>
              {actions ? (
                <div
                  className="flex min-w-0 shrink items-center justify-end gap-2"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                >
                  {actions}
                </div>
              ) : null}
              {windowControls ? (
                <div
                  className="flex shrink-0 items-center gap-1"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                >
                  {windowControls}
                </div>
              ) : null}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto scroll-overlay">
            <div
              className={cn("px-2 py-2 space-y-2 w-full", contentClassName)}
              {...unsavedChangesHandlers}
            >
              {children}
            </div>
          </div>

          {footer && (
            <div
              className="flex-shrink-0 py-2 border-t border-border-default"
              style={{ backgroundColor: "hsl(var(--background))" }}
            >
              <div className="px-2 flex items-center justify-end gap-2">
                {footer}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    host ?? document.body,
  );
};
