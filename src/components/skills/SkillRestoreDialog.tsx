import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { SkillBackupEntry } from "@/lib/api/skills";
import { cn } from "@/lib/utils";
import { V7Dialog } from "@/components/mcp/formBits";

function formatSkillBackupDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime())
    ? String(unixSeconds)
    : date.toLocaleString();
}

interface SkillRestoreDialogProps {
  open: boolean;
  backups: SkillBackupEntry[];
  isLoading: boolean;
  isRestoring: boolean;
  isDeleting: boolean;
  /** 恢复后会在这些应用启用（写在说明里，不藏） */
  targetsLabel: string;
  onRestore: (backupId: string) => void;
  onDelete: (backup: SkillBackupEntry) => void;
  onClose: () => void;
}

/** 「从备份恢复…」：列出卸载 / 更新前留下的备份。 */
export function SkillRestoreDialog({
  open,
  backups,
  isLoading,
  isRestoring,
  isDeleting,
  targetsLabel,
  onRestore,
  onDelete,
  onClose,
}: SkillRestoreDialogProps) {
  const { t } = useTranslation();
  const pending = isRestoring || isDeleting;
  return (
    <V7Dialog
      open={open}
      width={600}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <div className="flex shrink-0 flex-col gap-1">
        <DialogTitle className="text-[12.35px] leading-[1.3] font-semibold">
          {t("skills.restoreFromBackup.title")}
        </DialogTitle>
        <DialogDescription className="text-[12.35px] leading-[1.3] text-fg-2">
          {t("skillsPage.restore.lead", { apps: targetsLabel })}
        </DialogDescription>
      </div>

      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <p className="m-0 py-10 text-center text-[12.35px] leading-[1.3] text-fg-2">
            {t("common.loading")}
          </p>
        ) : backups.length === 0 ? (
          <p className="m-0 py-10 text-center text-[12.35px] leading-[1.3] text-fg-2">
            {t("skills.restoreFromBackup.empty")}
          </p>
        ) : (
          <ul className="m-0 list-none rounded-[8px] border border-border p-0">
            {backups.map((backup, index) => (
              <li
                key={backup.backupId}
                className={cn(
                  "flex items-start gap-2 px-2 py-2",
                  index > 0 && "border-t border-border",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12.35px] leading-[1.3] font-medium">
                      {backup.skill.name}
                    </span>
                    <span className="truncate font-mono text-[12.35px] leading-[1.3] text-fg-3">
                      {backup.skill.directory}
                    </span>
                  </div>
                  {backup.skill.description && (
                    <span className="text-[12.35px] leading-[1.3] text-fg-2">
                      {backup.skill.description}
                    </span>
                  )}
                  <span className="text-[12.35px] leading-[1.3] text-fg-2">
                    {t("skills.restoreFromBackup.createdAt")}:{" "}
                    {formatSkillBackupDate(backup.createdAt)}
                  </span>
                  <span
                    className="break-all font-mono text-[12.35px] leading-[1.3] text-fg-3"
                    title={backup.backupPath}
                  >
                    {backup.backupPath}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="neutral"
                    size="compact"
                    disabled={pending}
                    onClick={() => onRestore(backup.backupId)}
                  >
                    {isRestoring
                      ? t("skills.restoreFromBackup.restoring")
                      : t("skills.restoreFromBackup.restore")}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    size="compact"
                    className="text-danger-text hover:text-danger-text"
                    disabled={pending}
                    onClick={() => onDelete(backup)}
                  >
                    {isDeleting
                      ? t("skills.restoreFromBackup.deleting")
                      : t("skills.restoreFromBackup.delete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 justify-end pt-1">
        <Button
          type="button"
          variant="neutral"
          disabled={pending}
          onClick={onClose}
        >
          {t("common.close")}
        </Button>
      </div>
    </V7Dialog>
  );
}
