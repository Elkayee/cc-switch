import { useTranslation } from "react-i18next";
import { fmtUsd, formatTokensShort } from "./format";

interface UsageTooltipCardProps {
  heading: string;
  tokens: number;
  requests: number;
  /** 美元；null 表示没有可计价的数据 */
  cost: number | null;
}

/** 热力图格子、趋势柱的悬停卡片：同一时间段的 Token、请求数和费用一起看。 */
export function UsageTooltipCard({
  heading,
  tokens,
  requests,
  cost,
}: UsageTooltipCardProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const rows = [
    {
      label: t("usage.trend.tokens"),
      value: formatTokensShort(tokens, language),
    },
    {
      label: t("usage.trend.requests"),
      value: formatTokensShort(requests, language),
    },
    {
      label: t("usage.trend.cost"),
      value: cost == null ? "--" : fmtUsd(cost, 2),
    },
  ];

  return (
    <div className="min-w-[180px] rounded-[8px] border border-border bg-card px-2 py-2 shadow-lg">
      <p className="m-0 mb-2 whitespace-nowrap text-ui font-semibold text-foreground">
        {heading}
      </p>
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-ui">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="text-end tabular-nums text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
