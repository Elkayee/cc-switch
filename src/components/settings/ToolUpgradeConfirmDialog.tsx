import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ToolInstallationReport } from "@/lib/api/settings";
import { ToolInstallRow } from "./ToolInstallRow";

interface ToolUpgradeConfirmDialogProps {
  isOpen: boolean;
  plans: ToolInstallationReport[];
  displayName: (tool: string) => string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 升级前的「多处安装确认」。仅当某工具检测到 ≥2 处安装时弹出：展示命令行实际命中
 * 哪处（标「默认」= 升级目标）、各处版本，以及锚定后将执行的命令，让用户在
 * 「升级只动其中一处、其余不动」这件事上知情后再确认。单处安装不会走到这里。
 */
export function ToolUpgradeConfirmDialog({
  isOpen,
  plans,
  displayName,
  onConfirm,
  onCancel,
}: ToolUpgradeConfirmDialogProps) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // 队首切换后移开操作按钮的焦点，按住 Enter/Space 不能继续处理下一项。
  useEffect(() => {
    if (isOpen) titleRef.current?.focus();
  }, [isOpen, plans]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="w-full max-w-[480px] gap-2 rounded-[8px] p-2 text-ui sm:rounded-[8px]"
        zIndex="alert"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader className="space-y-2 border-b-0 bg-transparent p-0">
          <DialogTitle
            ref={titleRef}
            tabIndex={-1}
            className="flex items-center gap-2 text-ui font-semibold"
          >
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            {t("settings.toolUpgradeConfirmTitle")}
          </DialogTitle>
          <DialogDescription className="text-ui leading-[1.3]">
            {t("settings.toolUpgradeConfirmHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {plans.map((plan) => (
            <div
              key={plan.tool}
              className="space-y-1.5 rounded-[8px] border border-yellow-500/20 bg-yellow-500/5 p-2"
            >
              <div className="text-ui font-medium">
                {displayName(plan.tool)}
              </div>
              {!plan.anchored && (
                <div className="text-ui leading-[1.3] text-yellow-600 dark:text-yellow-400">
                  {t("settings.toolUpgradeUnanchoredHint")}
                </div>
              )}
              <ul className="space-y-1">
                {plan.installs.map((inst) => (
                  <li key={inst.path}>
                    <ToolInstallRow inst={inst} />
                  </li>
                ))}
              </ul>
              <div className="space-y-0.5">
                <div className="text-ui text-muted-foreground">
                  {t("settings.toolUpgradeWillRun")}
                </div>
                <code
                  className="block truncate rounded-[8px] bg-background/80 px-1.5 py-0.5 font-mono text-ui text-foreground"
                  title={plan.command}
                >
                  {plan.command}
                </code>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2 border-t-0 bg-transparent p-0 sm:justify-end">
          <Button
            variant="outline"
            onClick={(event) => {
              if (event.detail <= 1) onCancel();
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={(event) => {
              // 第二次 click 可能已经面对下一项计划，不能把双击视作两次授权。
              if (event.detail <= 1) onConfirm();
            }}
          >
            {t("settings.toolUpgradeConfirmBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
