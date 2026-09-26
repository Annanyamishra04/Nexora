import { DEFAULT_MODEL } from "@/lib/ai/gemini";

/**
 * Deliberately read-only: the phase brief requires that "user cannot
 * select arbitrary provider/model strings to bypass server
 * configuration" (see AI provider hardening, and lib/ai/gemini.ts, which
 * only ever reads GEMINI_MODEL from the server environment, never from a
 * request). So this section explains what's configured rather than
 * offering a selector that would either be fake (not wired to anything)
 * or a way to override server config from the client — both excluded by
 * the brief.
 */
export function AiPreferencesSection() {
  const configured = process.env.GEMINI_MODEL;
  const model = configured || DEFAULT_MODEL;
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);

  return (
    <section className="card-surface p-5">
      <h2 className="mb-1 text-base font-medium text-ink">AI preferences</h2>
      <p className="mb-4 text-sm text-ink-muted">
        Nexora&apos;s AI model is configured on the server, not per person — this keeps every
        conversation using a model the deployment has actually been set up (and paid for, on a
        paid tier) to support.
      </p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-muted">Chat model</dt>
        <dd className="text-ink">
          {model}
          {!configured && <span className="text-ink-faint"> (default)</span>}
        </dd>
        <dt className="text-ink-muted">AI responses</dt>
        <dd className="text-ink">
          {hasApiKey ? (
            "Configured"
          ) : (
            <span className="text-danger-500">
              Not configured — set GEMINI_API_KEY on the server to enable real responses.
            </span>
          )}
        </dd>
      </dl>
    </section>
  );
}
