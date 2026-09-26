import { createClient } from "@/lib/supabase/server";
import { errorResponse } from "@/lib/api/error-response";
import { chatError } from "@/lib/chat/errors";
import { toSearchResult } from "@/lib/conversations/search";
import { searchQuerySchema } from "@/lib/validation/conversation";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESULT_LIMIT = 20;

/**
 * GET /api/conversations/search?q=…
 *
 * Title + message-text search over the *caller's own* conversations. All
 * matching happens inside the search_conversations database function
 * (migration 0007), which is SECURITY INVOKER and hard-scoped to
 * auth.uid(); this handler adds no query logic of its own, so there is no
 * second place where scoping could be forgotten.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse(chatError("unauthenticated", "You must be signed in."));

  const rateLimit = await checkRateLimit(supabase, "conversation_search");
  if (!rateLimit.ok) {
    return errorResponse(
      chatError("rate_limit_unavailable", "Request protection is temporarily unavailable. Please try again in a moment.")
    );
  }
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many searches. Please slow down.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  const parsed = searchQuerySchema.safeParse(new URL(request.url).searchParams.get("q") ?? undefined);
  if (!parsed.success) {
    return errorResponse(chatError("invalid_request", parsed.error.issues[0]?.message ?? "Invalid search."));
  }

  const { data, error } = await supabase.rpc("search_conversations", {
    search_query: parsed.data,
    result_limit: RESULT_LIMIT,
  });

  if (error) return errorResponse(chatError("database_error", "Search isn't available right now."));

  return Response.json({ results: (data ?? []).map(toSearchResult) });
}
