import type { Metadata } from "next";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Nexora — AI Knowledge Workspace",
    template: "%s",
  },
  description:
    "Nexora is an AI knowledge workspace for conversations grounded in your own documents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Brand typefaces: loaded as a stylesheet (not next/font) so a build with no
            network access to Google Fonts still succeeds — the CSS variables in
            globals.css already fall back to solid system fonts if this fails to load. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app-router root layout is a single shared shell, not a per-page file; this rule predates the app directory. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
        {/* Applies the saved theme before first paint so there is never a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
