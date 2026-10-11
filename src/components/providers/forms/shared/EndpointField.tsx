import { useTranslation } from "react-i18next";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Link2, Zap } from "lucide-react";
import { REQUIRED_LABEL } from "../BasicFormFields";

interface EndpointFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  fullUrlHint?: string;
  showManageButton?: boolean;
  onManageClick?: () => void;
  manageButtonLabel?: string;
  showFullUrlToggle?: boolean;
  isFullUrl?: boolean;
  onFullUrlChange?: (value: boolean) => void;
}

export function EndpointField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  fullUrlHint,
  showManageButton = true,
  onManageClick,
  manageButtonLabel,
  showFullUrlToggle = false,
  isFullUrl = false,
  onFullUrlChange,
}: EndpointFieldProps) {
  const { t } = useTranslation();

  const defaultManageLabel = t("providerForm.manageAndTest", {
    defaultValue: "管理和测速",
  });
  const effectiveHint =
    showFullUrlToggle && isFullUrl
      ? fullUrlHint ||
        t("providerForm.fullUrlHint", {
          defaultValue:
            "💡 请填写完整请求 URL，并且必须开启代理后使用；代理将直接使用此 URL，不拼接路径",
        })
      : hint;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <FormLabel htmlFor={id} className={REQUIRED_LABEL}>
            {label}
          </FormLabel>
          {showFullUrlToggle && onFullUrlChange ? (
            <div className="flex items-center gap-2 rounded-[8px] border border-border/70 bg-muted/30 px-2 py-1">
              <Link2
                className={`h-3.5 w-3.5 ${isFullUrl ? "text-primary" : "text-muted-foreground"}`}
              />
              <span
                className={`text-ui font-medium ${
                  isFullUrl ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {t("providerForm.fullUrlLabel", {
                  defaultValue: "完整 URL",
                })}
              </span>
              <Switch
                checked={isFullUrl}
                onCheckedChange={onFullUrlChange}
                aria-label={t("providerForm.fullUrlLabel", {
                  defaultValue: "完整 URL",
                })}
              />
            </div>
          ) : null}
        </div>
        {showManageButton && onManageClick ? (
          <Button type="button" variant="ghost" onClick={onManageClick}>
            <Zap className="h-4 w-4" />
            {manageButtonLabel || defaultManageLabel}
          </Button>
        ) : null}
      </div>
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        aria-required="true"
      />
      {effectiveHint ? (
        <div className="p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-[8px]">
          <p className="text-ui text-amber-600 dark:text-amber-400">
            {effectiveHint}
          </p>
        </div>
      ) : null}
    </div>
  );
}
