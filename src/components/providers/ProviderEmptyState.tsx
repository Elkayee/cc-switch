import { Download, Plus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { AppId } from "@/lib/api/types";

interface ProviderEmptyStateProps {
  appId: AppId;
  onCreate?: () => void;
  onImport?: () => void;
}

/**
 * 供应商页空状态（v7 PANELS_BRIEF 空状态规则）：列表区居中，标题 15/600 +
 * 一段 13px --text-2 + 按钮。页头已经有实心的「添加供应商」，这里一律描边。
 */
export function ProviderEmptyState({
  appId,
  onCreate,
  onImport,
}: ProviderEmptyStateProps) {
  const { t } = useTranslation();
  // Pi / MiniMax Code 的"当前供应商"可以是原生应用自管的内置账号（不在可管理的
  // live 节点里），没有可导入的内容，列表也不提供导入按钮，因此不能沿用
  // "请点击导入当前配置"的通用文案。
  const emptyCopyNs = appId === "pi" || appId === "mcode" ? appId : null;
  const showKeyFieldsHint =
    appId === "claude" ||
    appId === "codex" ||
    appId === "gemini" ||
    appId === "grokbuild";

  return (
    <div className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-border p-10 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <Users className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="text-ui font-semibold">
        {emptyCopyNs
          ? t(`${emptyCopyNs}.empty.title`)
          : t("provider.noProviders")}
      </h3>
      <p className="mt-2 max-w-lg text-ui text-muted-foreground">
        {emptyCopyNs
          ? t(`${emptyCopyNs}.empty.description`)
          : t("provider.noProvidersDescription")}
      </p>
      {(onImport || onCreate) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onImport && (
            <Button variant="neutral" onClick={onImport}>
              <Download className="h-4 w-4" />
              {appId === "claude-desktop"
                ? t("provider.importFromClaude")
                : t("provider.importCurrent")}
            </Button>
          )}
          {onCreate && (
            <Button variant="neutral" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              {t("provider.addProvider")}
            </Button>
          )}
        </div>
      )}
      {showKeyFieldsHint && (
        <p className="mt-2 max-w-lg text-ui text-muted-foreground">
          {t("provider.noProvidersDescriptionKeyFields")}
        </p>
      )}
    </div>
  );
}
