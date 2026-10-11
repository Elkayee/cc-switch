import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FetchedModel } from "@/lib/api/model-fetch";

interface FetchedModelPickerProps {
  models: FetchedModel[];
  configuredModelIds: string[];
  onAdd: (modelIds: string[]) => void;
}

export function FetchedModelPicker({
  models,
  configuredModelIds,
  onAdd,
}: FetchedModelPickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const configuredIds = new Set(configuredModelIds);
  const query = search.trim().toLowerCase();
  const visibleModels = models.filter(
    (model) =>
      model.id.toLowerCase().includes(query) ||
      model.ownedBy?.toLowerCase().includes(query),
  );
  const selectedModels = models.filter(
    (model) => selectedIds.has(model.id) && !configuredIds.has(model.id),
  );

  return (
    <fieldset className="min-w-0 space-y-2 rounded-[8px] border border-border-default p-3">
      <legend className="px-1 text-[12.35px] leading-[1.3] font-medium">
        {t("providerForm.fetchedModelsTitle", {
          count: models.length,
          defaultValue: "Available models ({{count}})",
        })}
      </legend>
      <ImeSafeInput
        value={search}
        onValueChange={setSearch}
        onKeyDown={(event) => {
          // The picker lives inside the provider <form>; Enter here must not
          // trigger implicit submission.
          if (event.key === "Enter") event.preventDefault();
        }}
        aria-label={t("providerForm.searchModelPlaceholder", {
          defaultValue: "Search models...",
        })}
        placeholder={t("providerForm.searchModelPlaceholder", {
          defaultValue: "Search models...",
        })}
      />
      <ScrollArea className="h-48" type="auto">
        <div className="space-y-1 pr-3">
          {visibleModels.length === 0 && (
            <p className="py-4 text-center text-[12.35px] leading-[1.3] text-fg-2">
              {t("providerForm.searchModelEmpty", {
                defaultValue: "No matching models.",
              })}
            </p>
          )}
          {visibleModels.map((model) => {
            const isConfigured = configuredIds.has(model.id);
            return (
              <label
                key={model.id}
                className="flex items-center gap-2 px-2 py-1 hover:bg-muted"
              >
                <Checkbox
                  aria-label={model.id}
                  checked={isConfigured || selectedIds.has(model.id)}
                  disabled={isConfigured}
                  onCheckedChange={(checked) =>
                    setSelectedIds((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(model.id);
                      else next.delete(model.id);
                      return next;
                    })
                  }
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 break-all text-[12.35px] leading-[1.3]">
                  {model.id}
                  {model.ownedBy && (
                    <span className="block text-[12.35px] leading-[1.3] text-fg-2">
                      {model.ownedBy}
                    </span>
                  )}
                </span>
                {isConfigured && (
                  <span className="shrink-0 text-[12.35px] leading-[1.3] text-fg-2">
                    {t("providerForm.modelAlreadyAdded", {
                      defaultValue: "Already added",
                    })}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </ScrollArea>
      <div className="flex justify-end">
        {/* Neutral, not solid: the picker sits inside a provider form whose
            only solid button is Save. */}
        <Button
          type="button"
          variant="neutral"
          size="sm"
          disabled={selectedModels.length === 0}
          onClick={() => {
            onAdd(selectedModels.map((model) => model.id));
            setSelectedIds(new Set());
          }}
        >
          {t("providerForm.addSelectedModels", {
            count: selectedModels.length,
            defaultValue: "Add selected ({{count}})",
          })}
        </Button>
      </div>
    </fieldset>
  );
}
