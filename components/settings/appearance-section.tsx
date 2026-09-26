"use client";

import { ThemeToggle } from "@/components/layout/theme-toggle";

export function AppearanceSection() {
  return (
    <section className="card-surface p-5">
      <h2 className="mb-1 text-base font-medium text-ink">Appearance</h2>
      <p className="mb-4 text-sm text-ink-muted">
        Choose how Nexora looks on this device. &quot;System&quot; follows your OS setting and
        switches automatically.
      </p>
      <ThemeToggle />
    </section>
  );
}
