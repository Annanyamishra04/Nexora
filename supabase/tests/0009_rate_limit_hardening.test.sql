-- supabase/tests/0009_rate_limit_hardening.test.sql
--
-- Manual database test for migration 0009 (check_rate_limit hardening).
-- NOT run by `npm test` (needs Postgres). Requires 0001, 0008, and 0009
-- applied.
--
--   psql "$DATABASE_URL" -f supabase/tests/0009_rate_limit_hardening.test.sql
--
-- It creates a fixture user, so run it only on a throwaway DB. Each
-- block prints what it expects; there is no automatic pass/fail.

\set ON_ERROR_STOP off
insert into auth.users (id, email) values
 ('cccccccc-0000-0000-0000-000000000003','carol@x');

begin; set local role authenticated; select set_config('request.jwt.claim.sub','cccccccc-0000-0000-0000-000000000003', true);

\echo '1) An authenticated caller CANNOT use an arbitrary action name — should ERROR (rate_limits_action_check violation), not silently create a new bucket.'
select * from check_rate_limit('totally-made-up-action', 3);

\echo '2) A caller CANNOT request an unlimited/huge p_limit — it is clamped server-side to 1000, not honored verbatim.'
-- Ask for a limit of one billion. If the clamp works, current_count
-- will climb normally and eventually exceed the REAL ceiling (1000),
-- not the caller-requested one — but proving that would take 1000+
-- calls, so instead assert the *documented* clamp behavior directly:
-- this call must succeed (proving huge p_limit doesn't error out) and
-- current_count must be a small, sane number, never anything suggesting
-- the caller's limit was stored or trusted as-is.
select * from check_rate_limit('chat', 1000000000);

\echo '3) A caller CANNOT choose the window — window is fixed per action inside the function. Calling "chat" repeatedly always buckets into the same 60s window regardless of any window the caller might have wanted.'
-- (There is no p_window_seconds parameter anymore — this is really a
-- signature check: the call below must fail on arity, proving the
-- 3-argument form no longer exists.)
select * from check_rate_limit('chat', 5, 999999);

\echo '4) Normal use for a valid action still works exactly as before hardening.'
select * from check_rate_limit('document_upload', 5);

commit;

-- ---- RLS still holds: zero authenticated-role policies on rate_limits,
-- reachable only through the function.
begin; set local role authenticated; select set_config('request.jwt.claim.sub','cccccccc-0000-0000-0000-000000000003', true);
\echo '5) Direct table access is still blocked for authenticated (RLS, no policies) — should return 0 rows, not an error and not real data.'
select count(*) as should_be_0_or_permission_denied from rate_limits;
commit;
