import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { REQUIRED_LABEL } from "./BasicFormFields";

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  id?: string;
  /** 标签行右侧（「获取 API Key ↗」） */
  labelAside?: React.ReactNode;
  /** 输入框下方的说明文字 */
  hint?: React.ReactNode;
}

const ApiKeyInput: React.FC<ApiKeyInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  required = false,
  label = "API Key",
  id = "apiKey",
  labelAside,
  hint,
}) => {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className={cn(
            "block text-[12.35px] leading-[1.3] font-medium text-foreground",
            required && REQUIRED_LABEL,
          )}
        >
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        <Input
          type={showKey ? "text" : "password"}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t("apiKeyInput.placeholder")}
          disabled={disabled}
          // 只标给读屏，不用原生 required：空 Key 由表单校验弹「仍要保存」确认，
          // 原生校验会抢先拦下提交
          aria-required={required || undefined}
          autoComplete="off"
          className="pr-8"
        />
        {!disabled && value && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-0 top-0"
            aria-label={showKey ? t("apiKeyInput.hide") : t("apiKeyInput.show")}
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        )}
      </div>
      {hint && <p className="text-ui text-muted-foreground">{hint}</p>}
    </div>
  );
};

export default ApiKeyInput;
