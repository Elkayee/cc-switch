import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { useDarkMode } from "@/hooks/useDarkMode";

export function ThemeToggle() {
  const { t } = useTranslation();
  const { setTheme } = useTheme();
  const isDark = useDarkMode();
  const nextLabel = isDark ? t("settings.themeLight") : t("settings.themeDark");

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={nextLabel}
      title={nextLabel}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="h-5 w-5 p-0 shrink-0 rounded-[4px] text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
