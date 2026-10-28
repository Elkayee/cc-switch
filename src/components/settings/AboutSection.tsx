import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Github, Globe, Info, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Badge } from "@/components/ui/badge";
import { WhatsNewDialog } from "@/components/WhatsNewDialog";
import { WHATS_NEW_ENTRIES, entriesUpTo } from "@/lib/whatsNew";
import { ViberSwitchLogo } from "@/components/BrandIcons";
import { settingsApi } from "@/lib/api/settings";
import { AppUpdateControls } from "./AppUpdateControls";

interface AboutSectionProps {
  isPortable: boolean;
}

const GITHUB_URL = "https://github.com/farion1231/cc-switch";
const WEBSITE_URL = "https://ccswitch.io";

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
  const openReleaseNotes = (targetVersion: string | null) => {
    const trimmed = targetVersion?.trim() ?? "";
    const display = trimmed
      ? trimmed.startsWith("v")
        ? trimmed
        : `v${trimmed}`
      : "";
    const url = display
      ? `${GITHUB_URL}/releases/tag/${display}`
      : `${GITHUB_URL}/releases`;
    void settingsApi.openExternal(url);
  };

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-ui font-semibold">{t("common.about")}</h3>
        <p className="text-ui text-muted-foreground">
          {t("settings.aboutHint")}
        </p>
      </header>

      <div className="rounded-panel border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-3">
          <ViberSwitchLogo className="h-9 w-9 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <div className="text-ui font-semibold text-foreground">
              {t("app.title")}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
              {isLoadingVersion ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <span className="tabular-nums">{`${t("common.version")} v${displayVersion}`}</span>
              )}
              {isPortable && (
                <Badge variant="secondary" className="gap-1">
                  <Info className="h-3 w-3" />
                  {t("settings.portableMode")}
                </Badge>
              )}
            </div>
            {isPortable && (
              <p className="m-0 mt-1 text-ui text-muted-foreground">
                {t("settings.portableUpdateHint")}
              </p>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AppUpdateControls />
          {recentEntries.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="compact"
              onClick={() => setWhatsNewOpen(true)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("whatsNew.recentTitle")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="neutral"
          size="compact"
          onClick={() => void settingsApi.openExternal(GITHUB_URL)}
        >
          <Github className="h-3.5 w-3.5" />
          {t("settings.github")}
        </Button>
        <Button
          type="button"
          variant="neutral"
          size="compact"
          onClick={() => void settingsApi.openExternal(WEBSITE_URL)}
        >
          <Globe className="h-3.5 w-3.5" />
          {t("settings.officialWebsite")}
        </Button>
        <Button
          type="button"
          variant="neutral"
          size="compact"
          onClick={() => openReleaseNotes(version)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("settings.releaseNotes")}
        </Button>
      </div>

      <WhatsNewDialog
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
        entries={recentEntries}
      />
    </section>
  );
}
