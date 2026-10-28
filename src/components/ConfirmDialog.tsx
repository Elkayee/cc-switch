import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "destructive" | "info";
  zIndex?: "base" | "nested" | "alert" | "top";
  /** 可选勾选项：提供 label 即显示，勾选状态经 onConfirm 参数回传 */
  checkboxLabel?: string;
  checkboxDefaultChecked?: boolean;
  pending?: boolean;
  onConfirm: (checkboxChecked: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  variant = "destructive",
  zIndex = "alert",
  checkboxLabel,
  checkboxDefaultChecked = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [checkboxChecked, setCheckboxChecked] = useState(
    checkboxDefaultChecked,
  );

  useEffect(() => {
    if (isOpen) {
      setCheckboxChecked(checkboxDefaultChecked);
    }
  }, [isOpen, checkboxDefaultChecked]);

  const IconComponent = variant === "info" ? Info : AlertTriangle;
  const iconClass =
    variant === "info" ? "h-4 w-4 text-blue-500" : "h-4 w-4 text-destructive";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="w-full max-w-[480px] gap-2 rounded-[8px] p-2 text-ui sm:rounded-[8px]"
        zIndex={zIndex}
      >
        <DialogHeader className="space-y-2 border-b-0 bg-transparent p-0">
          <DialogTitle className="flex items-center gap-2 text-[12.35px] font-semibold leading-[1.3] tracking-normal">
            <IconComponent className={iconClass} />
            {title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line text-[12.35px] leading-[1.3]">
            {message}
          </DialogDescription>
        </DialogHeader>
        {checkboxLabel ? (
          <label className="flex cursor-pointer select-none items-start gap-2">
            <Checkbox
              checked={checkboxChecked}
              disabled={pending}
              onCheckedChange={(value) => setCheckboxChecked(value === true)}
              className="mt-0.5"
            />
            <span className="text-ui leading-[1.3]">{checkboxLabel}</span>
          </label>
        ) : null}
        <DialogFooter className="gap-2 border-t-0 bg-transparent p-0 sm:justify-end">
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {cancelText || t("common.cancel")}
          </Button>
          <Button
            variant={variant === "info" ? "default" : "destructive"}
            disabled={pending}
            onClick={() =>
              // 未渲染勾选框时不得回传 defaultChecked 残留值
              onConfirm(checkboxLabel ? checkboxChecked : false)
            }
          >
            {confirmText || t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
