/**
 * 用量统计里几张表（请求日志、供应商、模型、定价）共用的样式：
 * 列头 muted、紧凑行高、分隔线 border；表格区自己横向滚动，页面不溢出。
 */
export const usageTable = {
  /** 外层：窄窗口时表格在这里横向滚动 */
  scroller: "w-full overflow-x-auto",
  table: "w-full border-collapse text-ui tabular-nums",
  headRow: "h-6 border-b border-border text-ui text-muted-foreground",
  th: "whitespace-nowrap px-2 text-start font-medium",
  thEnd: "whitespace-nowrap px-2 text-end font-medium",
  row: "h-8 border-b border-border",
  rowInteractive:
    "h-8 cursor-pointer border-b border-border transition-colors hover:bg-muted/50",
  td: "whitespace-nowrap px-2",
  tdEnd: "whitespace-nowrap px-2 text-end",
  mono: "font-mono text-ui",
  muted: "text-muted-foreground",
  empty: "py-2 text-center text-ui text-muted-foreground",
  skeleton: "h-[240px] animate-pulse rounded-[8px] bg-muted/30",
} as const;
