-- 0008_rate_limits.sql
-- Phase 6: lightweight, database-backed rate limiting. No Redis/Upstash —
-- a single small table plus one atomic RPC, consistent with this app's
-- "no external services beyond Supabase + Gemini" constraint.
--
-- Design: fixed-window counters keyed by (user_id, action, window_start).
-- A window is a bucket of `window_seconds` starting at the epoch, so
-- concurrent requests in the same window race safely via a single atomic
-- upsert (`on conflict ... do update ... returning`) rather than a
-- read-then-write. This is a fixed-window limiter (not sliding-window /
-- token-bucket) — simple, cheap to query, and precise enough for abuse
-- protection; it can allow up to ~2x the nominal limit across a window
-- boundary, which is an accepted trade-off for a free-tier deployment.
--
-- Scoped to authenticated users only, per the requirement that rate
-- limiting must not be IP-only: every caller into check_rate_limit is
-- already known to be `auth.uid()` (see lib/rate-limit.ts, which is only
-- ever invoked after the caller's session has been verified).

create table if not exists public.rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (user_id, action, window_start)
);

comment on table public.rate_limits is
  'Fixed-window request counters for lightweight, DB-backed rate limiting. Rows are short-lived — see cleanup below.';

-- Supports the cleanup delete and any manual inspection by window age.
create index if not exists rate_limits_window_start_idx
  on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;

-- No client-facing policies at all: this table is never read or written
-- directly by API route code via the request-scoped client's table
-- builder — only through check_rate_limit (security definer) below. With
-- RLS enabled and zero policies, it is completely inaccessible to the
-- `authenticated` role directly, which is the intended, most restrictive
-- default.

-- ---------------------------------------------------------------------------
-- check_rate_limit
--
-- SECURITY DEFINER (unlike match_document_chunks / search_conversations,
-- which are SECURITY INVOKER): this function must write to rate_limits on
-- behalf of the caller even though rate_limits has no INSERT/UPDATE policy
-- for `authenticated`. To keep that safe, the function:
--   - ignores any caller-supplied identity and uses auth.uid() only, so a
--     caller can never increment or read another user's counter;
--   - fixes `search_path = public` (defense against search_path hijacking
--     in SECURITY DEFINER functions);
--   - only ever touches rows it addresses by (auth.uid(), action,
--     window_start), never an arbitrary row.
--
-- Returns whether this call is allowed, the count after this call, and
-- the number of seconds until the current window resets (for a Retry-After
-- style hint) — all derived server-side; the caller never has to trust a
-- client-supplied count.
-- ---------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  current_count integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_window_seconds integer := greatest(coalesce(p_window_seconds, 60), 1);
  v_limit integer := greatest(coalesce(p_limit, 1), 1);
  v_window_start timestamptz;
  v_count integer;
begin
  if v_user_id is null then
    -- No session: fail closed rather than silently allowing unlimited
    -- calls. Callers only ever invoke this after verifying auth.getUser(),
    -- so this branch should be unreachable in practice.
    return query select false, 0, v_window_seconds;
    return;
  end if;

  -- Bucket the current time into a fixed window starting at the epoch.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  insert into public.rate_limits (user_id, action, window_start, request_count)
  values (v_user_id, p_action, v_window_start, 1)
  on conflict (user_id, action, window_start)
    do update set request_count = public.rate_limits.request_count + 1
  returning request_count into v_count;

  -- Opportunistic cleanup of old windows for this user/action so the
  -- table doesn't grow unbounded — no scheduled job needed. Cheap: at
  -- most a handful of rows per call, indexed on window_start.
  delete from public.rate_limits
   where user_id = v_user_id
     and action = p_action
     and window_start < v_window_start;

  return query
  select
    v_count <= v_limit,
    v_count,
    greatest(
      0,
      v_window_seconds - extract(epoch from (now() - v_window_start))::integer
    );
end;
$$;

comment on function public.check_rate_limit is
  'Atomic fixed-window rate-limit check/increment, hard-scoped to auth.uid() regardless of any argument — a caller can only ever affect their own counters. See lib/rate-limit.ts.';

grant execute on function public.check_rate_limit(text, integer, integer) to authenticated;
