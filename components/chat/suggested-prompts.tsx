"use client";

import { FileSearch, FileText, Code2, Search, Sparkles, type LucideIcon } from "lucide-react";

interface SuggestedPrompt {
  icon: LucideIcon;
  title: string;
  description: string;
  prompt: string;
}

const PROMPTS: SuggestedPrompt[] = [
  {
    icon: FileText,
    title: "Analyze a document",
    description: "Attach a file and pull out the key points",
    prompt: "Analyze the document I've attached and summarize the key points.",
  },
  {
    icon: FileSearch,
    title: "Summarize a long report",
    description: "Turn pages of detail into a short brief",
    prompt: "Summarize this report in a few clear paragraphs.",
  },
  {
    icon: Code2,
    title: "Explain this code",
    description: "Walk through what a snippet actually does",
    prompt: "Explain what this code does, step by step.",
  },
  {
    icon: Search,
    title: "Find information in my files",
    description: "Ask a question grounded in your documents",
    prompt: "Based on my uploaded documents, ",
  },
  {
    icon: Sparkles,
    title: "Help me research a topic",
    description: "Start exploring an idea from scratch",
    prompt: "Help me research ",
  },
];

export function SuggestedPrompts({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <div
      role="group"
      aria-label="Suggested prompts"
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {PROMPTS.map(({ icon: Icon, title, description, prompt }) => (
        <button
          key={title}
          type="button"
          onClick={() => onSelect(prompt)}
          className="group flex items-start gap-3 rounded-lg border border-line bg-paper-raised px-3.5 py-3 text-left shadow-subtle transition-all hover:-translate-y-0.5 hover:border-moss-300 hover:shadow-card"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-moss-50 text-moss-600 transition-colors group-hover:bg-moss-500 group-hover:text-on-accent">
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">{title}</span>
            <span className="mt-0.5 block truncate text-xs text-ink-muted">{description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
