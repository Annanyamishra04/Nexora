import type { Config } from "tailwindcss";

/** Token colors read live CSS custom properties (set per-theme in globals.css) so every
 *  existing `bg-paper`, `text-ink`, `border-line`, `bg-moss-500` class keeps working
 *  unchanged while its actual value flips between the light and dark palettes. */
function themedColor(variable: string) {
  return `rgb(var(${variable}) / <alpha-value>)`;
}

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: themedColor("--color-paper"),
          raised: themedColor("--color-paper-raised"),
          overlay: themedColor("--color-paper-overlay"),
        },
        ink: {
          DEFAULT: themedColor("--color-ink"),
          muted: themedColor("--color-ink-muted"),
          faint: themedColor("--color-ink-faint"),
        },
        line: {
          DEFAULT: themedColor("--color-line"),
          strong: themedColor("--color-line-strong"),
        },
        moss: {
          50: themedColor("--color-moss-50"),
          100: themedColor("--color-moss-100"),
          300: themedColor("--color-moss-300"),
          500: themedColor("--color-moss-500"),
          600: themedColor("--color-moss-600"),
          700: themedColor("--color-moss-700"),
        },
        clay: {
          50: themedColor("--color-clay-50"),
          500: themedColor("--color-clay-500"),
        },
        danger: {
          50: themedColor("--color-danger-50"),
          500: themedColor("--color-danger-500"),
        },
        /** Fixed (theme-independent) light text/icon color for content sitting on a
         *  saturated accent fill (moss/danger/clay buttons) — those fills stay a similar
         *  mid-tone in both themes, so their foreground shouldn't flip with the theme. */
        "on-accent": "#FAFAF7",
        /** Code blocks stay a fixed dark chrome in both themes (their own syntax-friendly
         *  surface), rather than inheriting `ink`, which flips light in dark mode. */
        code: "#17181A",
      },
      fontFamily: {
        serif: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "8px",
        md: "10px",
        lg: "14px",
        xl: "18px",
      },
      boxShadow: {
        subtle: "0 1px 2px rgb(0 0 0 / 0.04)",
        panel: "0 1px 0 rgb(0 0 0 / 0.03)",
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 1px 1px rgb(0 0 0 / 0.03)",
        elevated: "0 12px 32px -12px rgb(0 0 0 / 0.28), 0 2px 8px -2px rgb(0 0 0 / 0.12)",
        "glow-accent": "0 0 0 3px rgb(var(--color-moss-500) / 0.12)",
      },
      maxWidth: {
        prose: "68ch",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.97)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "scale-in": "scale-in 120ms ease-out",
        shimmer: "shimmer 2.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
