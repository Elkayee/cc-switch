import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

type Theme = "light" | "dark" | "system";
type AdeTheme = "light" | "dark";

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeContextValue | undefined>(
  undefined,
);

/**
 * Apply Spec ADE / app resolved theme classes on <html>.
 * Keeps `.dark`/`.light` (Tailwind) and `.ade-theme-*` (ADE bridge) in sync.
 */
export function applyAdeTheme(theme: AdeTheme) {
  if (theme !== "light" && theme !== "dark") return;
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const adeClass = theme === "light" ? "ade-theme-light" : "ade-theme-dark";
  if (
    root.classList.contains(theme) &&
    root.classList.contains(adeClass) &&
    !root.classList.contains(theme === "light" ? "dark" : "light")
  ) {
    return;
  }

  // 切换期间暂停所有过渡（`.theme-switching`），否则各处的 transition-colors
  // 会让颜色一块块慢慢变过去。
  root.classList.add("theme-switching");
  root.classList.remove("light", "dark", "ade-theme-dark", "ade-theme-light");
  root.classList.add(theme);
  root.classList.add(adeClass);
  // 强制重排一次，让不带过渡的新颜色先落定，再在第二帧恢复过渡。
  void document.body?.offsetHeight;
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove("theme-switching");
      });
    });
  } else {
    root.classList.remove("theme-switching");
  }
}

function resolveSystemTheme(): AdeTheme {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readAdeThemeQuery(): AdeTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const param = new URLSearchParams(window.location.search).get("ade-theme");
    if (param === "light" || param === "dark") return param;
  } catch {
    // ignore malformed URL
  }
  return null;
}

/** First-paint boot: honor ?ade-theme= or an existing ADE class before React mounts. */
export function bootAdeTheme() {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const fromQuery = readAdeThemeQuery();
  const theme: AdeTheme | null =
    fromQuery ??
    (root.classList.contains("ade-theme-light")
      ? "light"
      : root.classList.contains("ade-theme-dark")
        ? "dark"
        : null);

  if (theme) applyAdeTheme(theme);
}

// Run once at module load for first paint / embed boot.
bootAdeTheme();

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "cc-switch-theme",
}: ThemeProviderProps) {
  const getInitialTheme = () => {
    if (typeof window === "undefined") {
      return defaultTheme;
    }

    // Host/query ADE theme wins over stored preference for embed first paint.
    const adeQuery = readAdeThemeQuery();
    if (adeQuery) return adeQuery;

    const stored = window.localStorage.getItem(storageKey) as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }

    return defaultTheme;
  };

  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(storageKey, theme);
  }, [theme, storageKey]);

  // Resolve app theme → ADE/Tailwind classes
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (theme === "system") {
      applyAdeTheme(resolveSystemTheme());
      return;
    }

    applyAdeTheme(theme);
  }, [theme]);

  // Follow OS theme when preference is "system"
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme !== "system") {
        return;
      }
      applyAdeTheme(mediaQuery.matches ? "dark" : "light");
    };

    if (theme === "system") {
      handleChange();
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  // Spec ADE host theme messages (iframe embed live switch)
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== "spec-ade" || data.type !== "ade:theme") {
        return;
      }
      if (data.theme !== "light" && data.theme !== "dark") {
        return;
      }
      // Host theme is authoritative while embedded — pin to explicit light/dark.
      setThemeState(data.theme);
      applyAdeTheme(data.theme);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Sync native window theme (Windows/macOS title bar)
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let isCancelled = false;

    const updateNativeTheme = async (nativeTheme: string) => {
      if (isCancelled) return;
      try {
        await invoke("set_window_theme", { theme: nativeTheme });
      } catch (e) {
        // Ignore errors (e.g., when not running in Tauri)
        console.debug("Failed to set native window theme:", e);
      }
    };

    // When "system", pass "system" so Tauri uses None (follows OS theme natively).
    // This keeps the WebView's prefers-color-scheme in sync with the real OS theme,
    // allowing effect #3's media query listener to fire on system theme changes.
    if (theme === "system") {
      updateNativeTheme("system");
    } else {
      updateNativeTheme(theme);
    }

    return () => {
      isCancelled = true;
    };
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (nextTheme: Theme) => {
        if (nextTheme === theme) return;
        setThemeState(nextTheme);
      },
    }),
    [theme],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
