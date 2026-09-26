/**
 * Next.js instrumentation hook (https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation).
 * `register()` runs once per server process, before any request is
 * handled. Used here only to fail production deployments clearly and
 * immediately when critical configuration (Supabase URL/anon key) is
 * missing, rather than letting the first real request crash inside
 * middleware with a confusing "Cannot read properties of undefined"
 * error. Local development is intentionally left lenient — see
 * lib/env.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateServerEnv } = await import("@/lib/env");
    validateServerEnv();
  }
}
