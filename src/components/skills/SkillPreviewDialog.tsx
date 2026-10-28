import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { skillsApi, type InstalledSkill } from "@/lib/api/skills";
import { SkillMarkdownBody, splitSkillMarkdown } from "./SkillMarkdown";

interface SkillPreviewDialogProps {
  skill: InstalledSkill | null;
  onClose: () => void;
}

export function SkillPreviewDialog({
  skill,
  onClose,
}: SkillPreviewDialogProps) {
  const { t } = useTranslation();
  const open = skill !== null;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["skills", "content", skill?.id],
    queryFn: () => skillsApi.getContent(skill!.id),
    enabled: open,
  });

  const parsed = data ? splitSkillMarkdown(data) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="!top-4 !bottom-4 !max-h-none !translate-y-0 w-[calc(100vw-16px)] max-w-2xl overflow-hidden"
        zIndex="nested"
      >
        <DialogHeader className="space-y-0 p-2">
          <DialogTitle className="text-[12.35px] font-semibold leading-[1.3]">
            {skill?.name ?? t("skills.previewTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="dialog-body-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {isLoading && (
            <div className="flex items-center gap-2 py-8 text-[12.35px] leading-[1.3] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("common.loading")}
            </div>
          )}
          {isError && (
            <p className="py-6 text-[12.35px] leading-[1.3] text-destructive">
              {t("skills.previewLoadFailed", {
                error: String(error),
              })}
            </p>
          )}
          {parsed && (
            <>
              <section className="mb-3">
                <h2 className="mb-1 text-[12.35px] font-semibold leading-[1.3] text-muted-foreground">
                  {t("skills.frontmatter")}
                </h2>
                <pre className="overflow-x-auto rounded-[4px] border border-black/10 bg-muted/40 px-2 py-2 font-mono text-[12.35px] leading-[1.3] dark:border-white/10">
                  {parsed.hasYaml
                    ? parsed.yaml || t("skills.frontmatterEmpty")
                    : t("skills.frontmatterMissing")}
                </pre>
              </section>
              <SkillMarkdownBody source={parsed.body} />
            </>
          )}
        </div>
        <DialogFooter className="p-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
