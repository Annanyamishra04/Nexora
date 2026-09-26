import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-moss-50 text-moss-600">
        <Icon size={21} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <h2 className="mb-1.5 text-base font-medium text-ink">{title}</h2>
      <p className="mb-5 max-w-sm text-sm text-ink-muted">{description}</p>
      {action}
    </div>
  );
}
