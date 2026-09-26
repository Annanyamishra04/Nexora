-- 0009_rate_limit_hardening.sql
-- Phase 6 targeted correction — RPC surface hardening.
--
-- Problem: check_rate_limit(p_action text, p_limit integer,
-- p_window_seconds integer) was GRANTed to `authenticated`, the same
-- Postgres role every browser session uses. Nothing stopped an
-- authenticated client from calling it directly (bypassing our Next.js
-- route entirely, using the same anon key + session JWT already present
-- client-side) with:
--   - an arbitrary p_action string, creating unbounded (user_id, action,
--     window_start) rows that are never revisited by the app's own
--     cleanup logic (which only prunes old windows for actions it
--     actually calls) — a storage-bloat / free-tier-cost vector;
--   - an arbitrary p_window_seconds, bucketing into windows the real
--     app-side check never looks at;
--   - an arbitrary p_limit, up to any size, for the `allowed` boolean
--     returned from *that specific direct call*.
--
-- None of this let a client change what limit OUR server enforces when
-- it calls this RPC for a real request (the server always supplies its
-- own env-configured p_limit, never a client-supplied one) — but per the
-- Phase 6 correction request, "the browser should not be able to choose
-- a huge p_limit / a tiny-or-huge window / arbitrary action names" at
-- all, as a defense-in-depth property of the RPC surface itself, not
-- just of how our own route happens to call it today.
--
-- Fix, smallest-change version (no new RPC names, no route changes):
--   1. `action` is now restricted at the table level to the three
--      actions the app actually uses, via a CHECK constraint. Any other
--      value fails the insert with a constraint-violation error —
--      surfaced to the caller as a normal Postgres error, which the app
--      already treats as "rate limiter unavailable" (see
--      lib/rate-limit.ts's `ok: false` path, Phase 6 correction) rather
--      than a bypass. This only ever affects the caller's own attempt;
--      it cannot corrupt another user's row.
--   2. `p_window_seconds` is removed as a function argument entirely.
--      The window is now decided inside the function via a fixed
--      per-action lookup, matching exactly what lib/rate-limit.ts's
--      getRateLimitConfig() always uses. A caller can no longer request
--      a different window for a given action under any circumstances.
--   3. `p_limit` is still accepted (preserves the RATE_LIMIT_*_PER_*
--      env-var configurability documented in the README/.env.example —
--      removing it would be a bigger change than necessary), but is now
--      clamped with `least(..., 1000)`: 1000 is the same hard ceiling
--      lib/rate-limit.ts's readEnvInt() already enforces on every
--      RATE_LIMIT_* env var, so a direct caller can never request a
--      limit any larger than the maximum this app would ever
--      legitimately configure for itself.
--
-- Everything else from 0008 is unchanged and still holds: RLS enabled
-- with zero authenticated-role table policies (reachable only through
-- this SECURITY DEFINER function), search_path pinned, auth.uid()-only
-- ownership, atomic upsert, fixed-window design, opportunistic cleanup.

alter table public.rate_limits
  add constraint rate_limits_action_check
  check (action in ('chat', 'document_upload', 'conversation_search'));

drop function if exists public.check_rate_limit(text, integer, integer);

create or replace function public.check_rate_limit(
  p_action text,
  p_limit integer
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
  -- Window is fixed per action, server-side, inside this function — a
  -- caller can no longer choose it. Must stay in sync with
  -- getRateLimitConfig() in lib/rate-limit.ts.
  v_window_seconds integer := case p_action
    when 'chat' then 60
    when 'document_upload' then 3600
    when 'conversation_search' then 60
    else null
  end;
  -- Hard ceiling matching the max any RATE_LIMIT_* env var can reach
  -- (lib/env.ts's readEnvInt clamps every one to [1, 1000]) — a direct
  -- caller can request a *smaller* limit than the app would (harmless,
  -- self-restricting) but never larger.
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 1000);
  v_window_start timestamptz;
  v_count integer;
begin
  if v_window_seconds is null then
    -- Unknown action: the rate_limits_action_check CHECK constraint
    -- would reject the insert below anyway, but failing here first
    -- avoids computing a meaningless window_start and gives a clearer
    -- error. Either way this only ever affects the caller's own
    -- request — no other user's data is touched.
    raise exception 'invalid rate limit action' using errcode = '22023';
  end if;

  if v_user_id is null then
    -- No session: fail closed rather than silently allowing unlimited
    -- calls. Callers only ever invoke this after verifying auth.getUser(),
    -- so this branch should be unreachable in practice.
    return query select false, 0, v_window_seconds;
    return;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  insert into public.rate_limits (user_id, action, window_start, request_count)
  values (v_user_id, p_action, v_window_start, 1)
  on conflict (user_id, action, window_start)
    do update set request_count = public.rate_limits.request_count + 1
  returning request_count into v_count;

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
  'Atomic fixed-window rate-limit check/increment, hard-scoped to auth.uid(). Phase 6 hardening: action is a fixed set (table CHECK), window is fixed per action inside this function (not caller-suppliable), and p_limit is clamped to <= 1000. See lib/rate-limit.ts.';

grant execute on function public.check_rate_limit(text, integer) to authenticated;
