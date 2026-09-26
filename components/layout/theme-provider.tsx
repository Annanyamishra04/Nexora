"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { THEME_STORAGE_KEY, getSystemTheme, isTheme, resolveTheme, type Theme } from "@/lib/theme";

interface ThemeContextValue {
  /** The person's stored preference — may be "system". */
  theme: Theme;
  /** What's actually applied right now: "light" or "dark". */
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyThemeClass(resolved: "light" | "dark") {
  const root = document.documentElement;
  // Briefly enable cross-fade transitions for the swap, then remove them so
  // they don't linger and slow down unrelated interactions.
  root.classList.add("theme-transition");
  root.classList.toggle("dark", resolved === "dark");
  window.setTimeout(() => root.classList.remove("theme-transition"), 200);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  // Pick up whatever the inline head script + localStorage already decided,
  // so this never fights the pre-hydration class the person already sees.
  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initial = isTheme(stored) ? stored : "system";
    setThemeState(initial);
    setResolvedTheme(resolveTheme(initial));
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      const next = getSystemTheme();
      setResolvedTheme(next);
      applyThemeClass(next);
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    const resolved = resolveTheme(next);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
