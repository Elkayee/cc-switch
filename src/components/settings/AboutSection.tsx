import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Badge } from "@/components/ui/badge";
import { WhatsNewDialog } from "@/components/WhatsNewDialog";
import { WHATS_NEW_ENTRIES, entriesUpTo } from "@/lib/whatsNew";
import appIcon from "@/assets/icons/app-icon.png";
import { AppUpdateControls } from "./AppUpdateControls";

interface AboutSectionProps {
  isPortable: boolean;
}

// 应用自身版本（getVersion，本地毫秒级、无网络）也缓存一份，纯为重挂时免去 loading 闪烁。
let appVersionCache: string | null = null;

/**
 * 设置 → 关于：版本、便携模式、应用更新、近期更新。
 * 命令行应用的安装与升级在侧栏「应用」页。
 */
export function AboutSection({ isPortable }: AboutSectionProps) {
  const { t } = useTranslation();
  // 惰性初始化自模块缓存：重挂时首帧即渲染上次的值，避免 loading 闪烁；首次挂载缓存
  // 为空则回退到原始初值（null / loading）。
  const [version, setVersion] = useState<string | null>(appVersionCache);
  const [isLoadingVersion, setIsLoadingVersion] = useState(
    () => appVersionCache === null,
  );
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const recentEntries = useMemo(
    () => (version ? entriesUpTo(WHATS_NEW_ENTRIES, version) : []),
    [version],
  );

  useEffect(() => {
    let active = true;
    const loadAppVersion = async () => {
      try {
        const appVersion = await getVersion();
        if (active) {
          appVersionCache = appVersion;
          setVersion(appVersion);
        }
      } catch (error) {
        console.error("[AboutSection] Failed to load version", error);
        if (active) {
          setVersion(null);
        }
      } finally {
        if (active) {
          setIsLoadingVersion(false);
        }
      }
    };

    void loadAppVersion();
    return () => {
      active = false;
    };
  }, []);

  const displayVersion = version ?? t("common.unknown");

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-ui font-semibold">{t("common.about")}</h3>
        <p className="text-ui text-muted-foreground">
          {t("settings.aboutHint")}
        </p>
      </header>

      <div className="rounded-[8px] border border-border bg-card p-2">
        <div className="flex items-center gap-2">
          <img
            src={appIcon}
            alt={t("app.title")}
            className="h-8 w-8 shrink-0 rounded-[8px]"
          />
          <div className="flex flex-col gap-1">
            <h4 className="text-ui font-semibold text-foreground">
              {t("app.title")}
            </h4>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-ui text-muted-foreground">
                <span>{t("common.version")}</span>
                {isLoadingVersion ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="font-medium text-foreground">{`v${displayVersion}`}</span>
                )}
              </div>
              {isPortable && (
                <Badge variant="secondary" className="gap-1">
                  <Info className="h-3 w-3" />
                  {t("settings.portableMode")}
                </Badge>
              )}
            </div>
            <AppUpdateControls />
            {recentEntries.length > 0 && (
              <div>
                <Button variant="outline" onClick={() => setWhatsNewOpen(true)}>
                  <Sparkles className="h-4 w-4" />
                  {t("whatsNew.recentTitle")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <WhatsNewDialog
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
        entries={recentEntries}
      />
    </section>
  );
}
