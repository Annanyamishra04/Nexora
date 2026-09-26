"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CodeBlock({ className, children }: { className?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const language = /language-(\w+)/.exec(className ?? "")?.[1];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; fail silently
      // rather than showing an alarming error for a non-critical action.
    }
  }

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-black/40 bg-code">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-xs text-white/50">{language ?? "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? (
            <>
              <Check size={12} strokeWidth={2} aria-hidden="true" /> Copied
            </>
          ) : (
            <>
              <Copy size={12} strokeWidth={1.75} aria-hidden="true" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className={cn("overflow-x-auto p-3 text-sm text-white/90 scrollbar-thin", className)}>
        <code>{children}</code>
      </pre>
    </div>
  );
}
