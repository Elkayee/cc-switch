import { useMemo } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Save,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { ImportStatus } from "@/hooks/useImportExport";

interface ImportExportSectionProps {
  status: ImportStatus;
  selectedFile: string;
  errorMessage: string | null;
  backupId: string | null;
  isImporting: boolean;
  onSelectFile: () => Promise<void>;
  onImport: () => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}

export function ImportExportSection({
  status,
  selectedFile,
  errorMessage,
  backupId,
  isImporting,
  onSelectFile,
  onImport,
  onExport,
  onClear,
}: ImportExportSectionProps) {
  const { t } = useTranslation();

  const selectedFileName = useMemo(() => {
    if (!selectedFile) return "";
    const segments = selectedFile.split(/[\\/]/);
    return segments[segments.length - 1] || selectedFile;
  }, [selectedFile]);

  return (
    <section className="space-y-2">
      <header className="space-y-2">
        <h3 className="text-ui font-semibold text-foreground">
          {t("settings.importExport")}
        </h3>
        <p className="text-ui text-muted-foreground">
          {t("settings.importExportHint")}
        </p>
      </header>

      <div className="space-y-2 rounded-[8px] border border-border bg-muted/40 p-2">
        {/* Import and Export Buttons Side by Side */}
        <div className="grid grid-cols-2 items-stretch gap-2">
          {/* Import Button */}
          <div className="relative">
            <Button
              type="button"
              className={`w-full bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 ${selectedFile && !isImporting ? "flex-col items-start" : "items-center"}`}
              onClick={!selectedFile ? onSelectFile : onImport}
              disabled={isImporting}
            >
              <div className="flex w-full items-center justify-center gap-1">
                {isImporting ? (
                  <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
                ) : selectedFile ? (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <FolderOpen className="h-4 w-4 flex-shrink-0" />
                )}
                <span className="font-medium">
                  {isImporting
                    ? t("settings.importing")
                    : selectedFile
                      ? t("settings.import")
                      : t("settings.selectConfigFile")}
                </span>
              </div>
              {selectedFile && !isImporting && (
                <div className="mt-1 w-full text-left">
                  <p className="truncate font-mono text-[12.35px] leading-[1.3] text-white/80">
                    {selectedFileName}
                  </p>
                </div>
              )}
            </Button>
            {selectedFile && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={onClear}
                className="absolute -right-2 -top-2 z-10"
                aria-label={t("common.clear")}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Export Button */}
          <div>
            <Button type="button" className="w-full" onClick={onExport}>
              <Save className="h-4 w-4" />
              {t("settings.exportConfig")}
            </Button>
          </div>
        </div>

        <ImportStatusMessage
          status={status}
          errorMessage={errorMessage}
          backupId={backupId}
        />
      </div>
    </section>
  );
}

interface ImportStatusMessageProps {
  status: ImportStatus;
  errorMessage: string | null;
  backupId: string | null;
}

function ImportStatusMessage({
  status,
  errorMessage,
  backupId,
}: ImportStatusMessageProps) {
  const { t } = useTranslation();

  if (status === "idle") {
    return null;
  }

  const baseClass =
    "flex items-start gap-2 rounded-[8px] border p-2 text-[12.35px] leading-[1.3] backdrop-blur-sm";

  if (status === "importing") {
    return (
      <div
        className={`${baseClass} border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400`}
      >
        <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
        <div>
          <p className="font-semibold">{t("settings.importing")}</p>
          <p className="text-blue-600/80 dark:text-blue-400/80">
            {t("common.loading")}
          </p>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div
        className={`${baseClass} border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400`}
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="space-y-1.5">
          <p className="font-semibold">{t("settings.importSuccess")}</p>
          {backupId ? (
            <p className="text-[12.35px] leading-[1.3] text-green-600/80 dark:text-green-400/80">
              {t("settings.backupId")}: {backupId}
            </p>
          ) : null}
          <p className="text-green-600/80 dark:text-green-400/80">
            {t("settings.autoReload")}
          </p>
        </div>
      </div>
    );
  }

  if (status === "partial-success") {
    return (
      <div
        className={`${baseClass} border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400`}
      >
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="space-y-1.5">
          <p className="font-semibold">{t("settings.importPartialSuccess")}</p>
          <p className="text-yellow-600/80 dark:text-yellow-400/80">
            {t("settings.importPartialHint")}
          </p>
        </div>
      </div>
    );
  }

  const message = errorMessage || t("settings.importFailed");

  return (
    <div
      className={`${baseClass} border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400`}
    >
      <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <div className="space-y-1.5">
        <p className="font-semibold">{t("settings.importFailed")}</p>
        <p className="text-red-600/80 dark:text-red-400/80">{message}</p>
      </div>
    </div>
  );
}
