import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSettingsQuery } from "@/lib/query";
import { settingsApi } from "@/lib/api";

type LanguageOption = "zh" | "zh-TW" | "en" | "ja" | "vi";

const LANGUAGE_OPTIONS: { value: LanguageOption; labelKey: string }[] = [
  { value: "zh", labelKey: "settings.languageOptionChinese" },
  { value: "zh-TW", labelKey: "settings.languageOptionTraditionalChinese" },
  { value: "en", labelKey: "settings.languageOptionEnglish" },
  { value: "ja", labelKey: "settings.languageOptionJapanese" },
  { value: "vi", labelKey: "settings.languageOptionVietnamese" },
];

/** Shown until the user picks a language, including existing installs after update. */
export function LanguagePickerDialog() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();

  const isOpen = settings != null && settings.languagePickerConfirmed !== true;
  const currentLanguage = settings?.language;

  const handleSelect = async (language: LanguageOption) => {
    if (!settings) return;
    try {
      const { webdavSync: _, ...rest } = settings;
      await settingsApi.save({
        ...rest,
        language,
        languagePickerConfirmed: true,
      });
      try {
        window.localStorage.setItem("language", language);
      } catch (error) {
        console.warn(
          "[LanguagePickerDialog] Failed to persist language",
          error,
        );
      }
      await i18n.changeLanguage(language);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("Failed to save language:", error);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-md"
        zIndex="top"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Languages className="h-5 w-5 text-blue-500" />
            {t("languagePicker.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          <DialogDescription>{t("languagePicker.hint")}</DialogDescription>
          <div className="flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={
                  option.value === currentLanguage ? "default" : "outline"
                }
                className={cn("min-w-[96px]")}
                onClick={() => void handleSelect(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
