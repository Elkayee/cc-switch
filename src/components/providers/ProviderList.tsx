import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter, type Modifier } from "@dnd-kit/core";
import { Search, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import type { OpenClawProviderConfig, Provider } from "@/types";
import { getOpencodeDeclaredModels } from "@/components/providers/forms/helpers/opencodeFormUtils";
import type { AppId } from "@/lib/api";
import { isTauri } from "@tauri-apps/api/core";
import { pinnedProxyUrl } from "@/lib/pinnedProxyUrl";
import { providersApi } from "@/lib/api/providers";
import {
  extractErrorMessage,
  translatePiProviderMutationError,
} from "@/utils/errorUtils";
import { useDragSort } from "@/hooks/useDragSort";
import {
  useOpenClawLiveProviderIds,
  useOpenClawDefaultModel,
} from "@/hooks/useOpenClaw";
import {
  useHermesLiveProviderIds,
  useHermesModelConfig,
} from "@/hooks/useHermes";
import { useStreamCheck } from "@/hooks/useStreamCheck";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderEmptyState } from "@/components/providers/ProviderEmptyState";
import {
  useCurrentOmoProviderId,
  useCurrentOmoSlimProviderId,
} from "@/lib/query/omo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/help-tip";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { isTextEditableTarget } from "@/utils/domUtils";
import { extractProviderBaseUrl } from "@/utils/providerConfigUtils";
import { usePiCurrentState } from "@/lib/query/pi";
import { isPiFamilyApp } from "@/config/appConfig";
import { isHermesReadOnlyProvider } from "@/config/hermesProviderPresets";
import {
  buildAdditiveSections,
  buildLaunchSections,
  buildSwitchSections,
  type CardPresentation,
  type ProviderSection,
  type SwitchModeInput,
} from "@/components/providers/presentation";

/** 切换式应用（Claude Code / Codex / Gemini CLI / Grok Build）的模式状态和动作，由供应商页传入。 */
export type SwitchModeProps = Omit<SwitchModeInput, "app" | "t" | "providers">;

const verticalDragModifiers: Modifier[] = [
  ({ transform }) => ({ ...transform, x: 0 }),
];

interface ProviderListProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  appId: AppId;
  /** 直连切换 / 共存式的添加 / Pi 的启用 / Claude Desktop 的切换 */
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onRemoveFromConfig?: (provider: Provider) => void;
  onDisableOmo?: () => void;
  onDisableOmoSlim?: () => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onCreate?: () => void;
  /** OpenClaw 的默认模型、Hermes 的当前供应商 */
  onSetAsDefault?: (provider: Provider, modelId?: string) => void;
  /** 切换式应用必传：按模式 tab 算卡片 */
  switchMode?: SwitchModeProps;
  isLoading?: boolean;
  /**
   * 搜索框开关。由页头搜索按钮控制时传入（upstream）：为 true 才显示搜索框并过滤，
   * Esc / ⌘F 通过 onSearchOpenChange 回写。不传（fork 默认）则搜索框常驻、始终过滤。
   */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /**
   * 模式行右端给搜索框留的位置（null＝位置还没挂上，先不画）；不传则放在列表第一行右端，
   * 与第一个分组标题同行
   */
  searchSlot?: HTMLElement | null;
  /** 固定路径路由（fork）：接管开启 + 代理运行时，卡片上出现「复制固定 URL」按钮 */
  pinnedTakeoverOn?: boolean;
  isProxyRunning?: boolean;
  proxyListenAddress?: string;
  proxyListenPort?: number;
}

export function ProviderList({
  providers,
  currentProviderId,
  appId,
  onSwitch,
  onEdit,
  onDelete,
  onRemoveFromConfig,
  onDisableOmo,
  onDisableOmoSlim,
  onDuplicate,
  onConfigureUsage,
  onOpenWebsite,
  onOpenTerminal,
  onCreate,
  onSetAsDefault,
  switchMode,
  isLoading = false,
  searchOpen,
  onSearchOpenChange,
  searchSlot,
  pinnedTakeoverOn = false,
  isProxyRunning = false,
  proxyListenAddress = "",
  proxyListenPort = 0,
}: ProviderListProps) {
  const { t } = useTranslation();
  const { checkProvider, isChecking } = useStreamCheck(appId);
  const { sortedProviders, sensors, handleDragEnd } = useDragSort(
    providers,
    appId,
  );

  const { data: opencodeLiveIds, isPending: isOpencodeLiveIdsPending } =
    useQuery({
      queryKey: ["opencodeLiveProviderIds"],
      queryFn: () => providersApi.getOpenCodeLiveProviderIds(),
      enabled: appId === "opencode",
    });
  const { data: opencodeDefaultModel } = useQuery({
    queryKey: ["opencodeDefaultModel"],
    queryFn: () => providersApi.getOpenCodeDefaultModel(),
    enabled: appId === "opencode",
  });
  const { data: openclawLiveIds, isPending: isOpenclawLiveIdsPending } =
    useOpenClawLiveProviderIds(appId === "openclaw");
  const { data: hermesLiveIds, isPending: isHermesLiveIdsPending } =
    useHermesLiveProviderIds(appId === "hermes");
  const { data: hermesModelConfig } = useHermesModelConfig(appId === "hermes");
  const { data: openclawDefaultModel } = useOpenClawDefaultModel(
    appId === "openclaw",
  );
  const isOpenCode = appId === "opencode";
  const { data: currentOmoId } = useCurrentOmoProviderId(isOpenCode);
  const { data: currentOmoSlimId } = useCurrentOmoSlimProviderId(isOpenCode);
  const {
    data: piCurrentState,
    isSuccess: isPiCurrentStateSuccess,
    isPending: isPiCurrentStatePending,
    isError: isPiCurrentStateError,
    error: piCurrentStateError,
  } = usePiCurrentState(isPiFamilyApp(appId), appId === "omp" ? "omp" : "pi");
  const isPiStateReady = !isPiFamilyApp(appId) || isPiCurrentStateSuccess;
  // 累加式应用要等 live 里有哪些供应商读回来（成功或失败）才知道卡片该进哪个分区；
  // 在那之前按加载中画骨架，不然卡片先全落进「可添加」，读回来再整体搬到「已添加」。
  // 一张卡都没有时不用等，直接出空状态
  const isLiveMembershipPending =
    (appId === "opencode" && isOpencodeLiveIdsPending) ||
    (appId === "openclaw" && isOpenclawLiveIdsPending) ||
    (appId === "hermes" && isHermesLiveIdsPending) ||
    (isPiFamilyApp(appId) && isPiCurrentStatePending);

  const isInConfig = useCallback(
    (provider: Provider): boolean => {
      switch (appId) {
        case "kimi":
        case "dsh":
        case "mcode":
          return provider.meta?.liveConfigManaged === true;
        case "opencode":
          return opencodeLiveIds?.includes(provider.id) ?? false;
        case "openclaw":
          return openclawLiveIds?.includes(provider.id) ?? false;
        case "hermes":
          return hermesLiveIds?.includes(provider.id) ?? false;
        case "pi":
        case "omp":
          return isPiStateReady
            ? (piCurrentState?.enabledProviderIds.includes(provider.id) ??
                false)
            : false;
        default:
          return true;
      }
    },
    [
      appId,
      opencodeLiveIds,
      openclawLiveIds,
      hermesLiveIds,
      isPiStateReady,
      piCurrentState,
    ],
  );

  const handleTest = useCallback(
    (provider: Provider) => {
      checkProvider(provider.id, provider.name);
    },
    [checkProvider],
  );

  const queryClient = useQueryClient();
  const importMutation = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (appId === "opencode") {
        return (await providersApi.importOpenCodeFromLive()) > 0;
      }
      if (appId === "openclaw") {
        return (await providersApi.importOpenClawFromLive()) > 0;
      }
      if (appId === "hermes") {
        return (await providersApi.importHermesFromLive()) > 0;
      }
      if (appId === "claude-desktop") {
        return (await providersApi.importClaudeDesktopFromClaude()) > 0;
      }
      return providersApi.importDefault(appId);
    },
    onSuccess: (imported) => {
      if (imported) {
        queryClient.invalidateQueries({ queryKey: ["providers", appId] });
        if (appId === "claude-desktop") {
          queryClient.invalidateQueries({ queryKey: ["claudeDesktopStatus"] });
        }
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: unknown) => {
      // Tauri invoke 的 reject 值是后端序列化出的纯字符串而非 Error 对象，
      // 取 .message 只会得到 undefined（空 toast）。
      toast.error(extractErrorMessage(error) || t("settings.importFailed"));
      // 导入失败前也可能已产生需要上屏的副作用：GrokBuild 官方登录态下点
      // 导入，命令层会先补种官方条目、随后才因 live 不可导入而报错。
      queryClient.invalidateQueries({ queryKey: ["providers", appId] });
    },
  });

  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => {
    const input = searchInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
    input.scrollIntoView?.({ block: "nearest" });
  }, []);
  const isSearchVisible = searchOpen === undefined || searchOpen;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        // 正在别的输入框/可编辑区域中时不抢占 Ctrl+F（例如添加供应商表单里
        // ProviderPresetSelector 的搜索框），避免与其同名快捷键冲突。
        if (
          isTextEditableTarget(document.activeElement) &&
          document.activeElement !== searchInputRef.current
        ) {
          return;
        }
        event.preventDefault();
        if (isSearchVisible) {
          // The list-row field may have scrolled out of view since it was opened.
          focusSearch();
        } else {
          onSearchOpenChange?.(true);
        }
        return;
      }

      if (key === "escape") {
        onSearchOpenChange?.(false);
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [isSearchVisible, focusSearch, onSearchOpenChange]);

  // 页头按钮打开搜索框后聚焦
  useEffect(() => {
    if (searchOpen) {
      const frame = requestAnimationFrame(focusSearch);
      return () => cancelAnimationFrame(frame);
    }
  }, [searchOpen, focusSearch]);

  // 每家可被搜到的文字：名称、备注、官网、请求地址（请求地址要解析配置，只随列表变化重算）
  const searchIndex = useMemo(
    () =>
      sortedProviders.map((provider) => ({
        provider,
        text: [
          provider.name,
          provider.notes,
          provider.websiteUrl,
          extractProviderBaseUrl(provider.settingsConfig),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase(),
      })),
    [sortedProviders],
  );

  // 搜索框关着（由页头控制时）就不再过滤：搜索词留着，下次打开还在，但列表不会悄悄少几家
  const filteredProviders = useMemo(() => {
    const keyword = isSearchVisible ? searchTerm.trim().toLowerCase() : "";
    if (!keyword) return sortedProviders;
    return searchIndex
      .filter((entry) => entry.text.includes(keyword))
      .map((entry) => entry.provider);
  }, [isSearchVisible, searchTerm, searchIndex, sortedProviders]);

  const sections = useMemo<ProviderSection[]>(() => {
    if (switchMode) {
      // 队列按没过滤的全部供应商剔掉已不存在的 id：序号和上下移要按完整队列算，
      // 搜索只决定画哪些卡
      const known = new Set(sortedProviders.map((p) => p.id));
      return buildSwitchSections({
        ...switchMode,
        app: appId,
        t,
        providers: filteredProviders,
        queue: switchMode.queue.filter((id) => known.has(id)),
      });
    }
    if (appId === "agy") {
      return buildLaunchSections({
        app: appId,
        t,
        providers: filteredProviders,
        openTerminal: (provider) => onOpenTerminal?.(provider),
      });
    }
    const defaultPrimary =
      (appId === "openclaw"
        ? openclawDefaultModel?.primary
        : appId === "opencode"
          ? opencodeDefaultModel
          : null) ?? "";
    const slash = defaultPrimary.indexOf("/");
    return buildAdditiveSections({
      app: appId,
      t,
      providers: filteredProviders,
      isInConfig,
      currentOmoId,
      currentOmoSlimId,
      defaultModel:
        slash > 0
          ? {
              providerId: defaultPrimary.slice(0, slash),
              model: defaultPrimary.slice(slash + 1),
            }
          : null,
      defaultModelOptions: (provider) => {
        if (appId === "opencode") {
          return getOpencodeDeclaredModels(
            provider.id,
            provider.settingsConfig,
          );
        }
        const config = provider.settingsConfig as OpenClawProviderConfig;
        if (!Array.isArray(config?.models)) return [];
        return config.models
          .filter((model) => typeof model.id === "string" && model.id.trim())
          .map((model) => ({ id: model.id, name: model.name }));
      },
      hermesCurrentId: hermesModelConfig?.provider ?? null,
      isHermesManaged: (provider) =>
        isHermesReadOnlyProvider(provider.settingsConfig),
      piStateUnavailable: isPiFamilyApp(appId) && !isPiStateReady,
      kimiCurrentId: currentProviderId,
      actions: {
        add: onSwitch,
        remove: (provider) =>
          onRemoveFromConfig
            ? onRemoveFromConfig(provider)
            : onDelete(provider),
        disableOmo: (provider) =>
          provider.category === "omo-slim"
            ? onDisableOmoSlim?.()
            : onDisableOmo?.(),
        setDefault: (provider, modelId) => onSetAsDefault?.(provider, modelId),
      },
    });
  }, [
    switchMode,
    appId,
    t,
    sortedProviders,
    filteredProviders,
    onSwitch,
    onOpenTerminal,
    openclawDefaultModel?.primary,
    opencodeDefaultModel,
    isInConfig,
    currentOmoId,
    currentOmoSlimId,
    hermesModelConfig?.provider,
    isPiStateReady,
    currentProviderId,
    onRemoveFromConfig,
    onDelete,
    onDisableOmo,
    onDisableOmoSlim,
    onSetAsDefault,
  ]);

  const piStateRawError =
    isPiFamilyApp(appId) && isPiCurrentStateError
      ? extractErrorMessage(piCurrentStateError)
      : "";
  const piStateError =
    translatePiProviderMutationError(piStateRawError, t) || piStateRawError;
  const piStateErrorNotice =
    isPiFamilyApp(appId) && isPiCurrentStateError ? (
      <Notice
        tone="warning"
        title={t(`${appId}.current.readFailed`, {
          defaultValue: "无法读取 Pi 当前配置",
        })}
      >
        {t(`${appId}.current.stateUnavailableHint`)}
        {piStateError ? ` ${piStateError}` : ""}
      </Notice>
    ) : null;

  if (isLoading || (isLiveMembershipPending && sortedProviders.length > 0)) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-12 w-full rounded-[8px] border border-dashed border-border bg-subtle"
          />
        ))}
      </div>
    );
  }

  if (sortedProviders.length === 0) {
    return (
      <div className="mt-2 space-y-2">
        {piStateErrorNotice}
        <ProviderEmptyState
          appId={appId}
          onCreate={isPiFamilyApp(appId) ? undefined : onCreate}
          onImport={
            isPiFamilyApp(appId) ||
            appId === "mcode" ||
            appId === "kimi" ||
            appId === "dsh"
              ? undefined
              : () => importMutation.mutate()
          }
        />
      </div>
    );
  }

  // 「当前」只用来决定额度显示和自动刷新：Pi 没有当前项，OMO / Hermes 各看自己的当前项；
  // Antigravity 没有「启用」，每张卡都随时能打开，额度一律照常显示
  const isCurrentFor = (provider: Provider) => {
    if (isPiFamilyApp(appId)) return false;
    if (appId === "agy") return true;
    if (provider.category === "omo") return provider.id === currentOmoId;
    if (provider.category === "omo-slim")
      return provider.id === currentOmoSlimId;
    if (appId === "hermes") return provider.id === hermesModelConfig?.provider;
    return provider.id === currentProviderId;
  };

  const pinnedUrlFor = (provider: Provider) =>
    pinnedProxyUrl({
      appId,
      providerId: provider.id,
      takeoverOn: pinnedTakeoverOn,
      proxyRunning: isProxyRunning,
      isTauri: isTauri(),
      pageHostname:
        typeof window === "undefined" ? "localhost" : window.location.hostname,
      listenAddress: proxyListenAddress,
      port: proxyListenPort,
    }) ?? undefined;

  const renderCard = (provider: Provider, presentation: CardPresentation) => (
    <SortableProviderCard
      key={provider.id}
      provider={provider}
      appId={appId}
      presentation={presentation}
      isCurrent={isCurrentFor(provider)}
      isInConfig={isInConfig(provider)}
      onEdit={onEdit}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onConfigureUsage={
        onConfigureUsage ? (item) => onConfigureUsage(item) : () => undefined
      }
      onOpenWebsite={onOpenWebsite}
      // Antigravity 的「打开终端」已经是主按钮，「更多」菜单里不再重复
      onOpenTerminal={appId === "agy" ? undefined : onOpenTerminal}
      onTest={handleTest}
      isTesting={isChecking(provider.id)}
      copyProxyUrl={pinnedUrlFor(provider)}
    />
  );

  // 搜索框放在列表上方第一行的最右端，不盖住卡片、打开时卡片也不下移
  const searchField = (
    <AnimatePresence>
      {isSearchVisible && (
        <motion.div
          key="provider-search"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 8 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="relative flex w-64 min-w-[10rem] shrink items-center"
        >
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
          <Input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("provider.searchPlaceholder", {
              defaultValue: "Search name, notes, or URL...",
            })}
            aria-label={t("provider.searchAriaLabel", {
              defaultValue: "Search providers",
            })}
            title={`${t("provider.searchScopeHint", {
              defaultValue:
                "Matches provider name, notes, website, and API address.",
            })} ${t("provider.searchCloseHint", {
              defaultValue: "Press Esc to close",
            })}`}
            className={searchTerm ? "pe-[5.5rem] ps-8" : "pe-9 ps-8"}
          />
          {searchTerm && (
            <Button
              variant="quiet"
              size="compact"
              className="absolute end-8 top-1/2 h-6 -translate-y-1/2 px-1.5"
              onClick={() => setSearchTerm("")}
            >
              {t("common.clear", { defaultValue: "Clear" })}
            </Button>
          )}
          <Button
            variant="quiet"
            size="icon-compact"
            className="absolute end-1 top-1/2 h-6 w-6 -translate-y-1/2"
            onClick={() => onSearchOpenChange?.(false)}
            aria-label={t("provider.searchCloseAriaLabel", {
              defaultValue: "Close provider search",
            })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const renderSectionTitle = (section: ProviderSection) => (
    <div className="flex items-center gap-1 text-caption font-semibold text-fg-2">
      <h2 className="m-0 text-caption font-semibold">{section.title}</h2>
      {section.help && (
        <HelpTip title={section.help.title}>{section.help.body}</HelpTip>
      )}
    </div>
  );

  // 没有模式行的应用：第一个分组标题和搜索框同一行。这一行一直在（搜不到结果时只剩搜索框），
  // 输入框在树里的位置不变，打字中途不会因为结果清空被重新挂载而丢焦点
  const hostedSearch = searchSlot !== undefined;
  const leadSection = sections[0];
  const liftLeadTitle =
    !hostedSearch &&
    Boolean(leadSection?.title) &&
    filteredProviders.length > 0;
  const showListHeader =
    !hostedSearch && (Boolean(leadSection?.title) || isSearchVisible);

  // 卡片列表铺满主区域，和页头同宽
  return (
    <div className="mt-2 space-y-3">
      {piStateErrorNotice}
      {searchSlot && createPortal(searchField, searchSlot)}
      {showListHeader && (
        <div
          className={cn(
            "flex min-h-8 items-center gap-3",
            liftLeadTitle && "-mb-2",
          )}
        >
          <div className="min-w-0 flex-1">
            {liftLeadTitle && renderSectionTitle(leadSection)}
          </div>
          {searchField}
        </div>
      )}

      {filteredProviders.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-border px-2 py-2 text-center text-ui text-muted-foreground">
          {t("provider.noSearchResults", {
            defaultValue: "No providers match your search.",
          })}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          modifiers={verticalDragModifiers}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          {sections.map((section, index) => (
            <section key={section.key} className="space-y-2">
              {section.title && !(index === 0 && liftLeadTitle) && (
                <div className="pt-1">{renderSectionTitle(section)}</div>
              )}
              {section.items.length === 0 && section.emptyText ? (
                <div className="rounded-[8px] border border-dashed border-border px-2 py-2 text-ui text-muted-foreground">
                  {section.emptyText}
                </div>
              ) : (
                <SortableContext
                  items={section.items.map((item) => item.provider.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {section.items.map((item) =>
                      renderCard(item.provider, item.presentation),
                    )}
                  </div>
                </SortableContext>
              )}
            </section>
          ))}
        </DndContext>
      )}
    </div>
  );
}

interface SortableProviderCardProps {
  provider: Provider;
  appId: AppId;
  presentation: CardPresentation;
  isCurrent: boolean;
  isInConfig: boolean;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onOpenTerminal?: (provider: Provider) => void;
  onTest?: (provider: Provider) => void;
  isTesting: boolean;
  copyProxyUrl?: string;
}

function SortableProviderCard(props: SortableProviderCardProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.provider.id });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ProviderCard
        {...props}
        dragHandleProps={{ attributes, listeners, isDragging }}
      />
    </div>
  );
}
