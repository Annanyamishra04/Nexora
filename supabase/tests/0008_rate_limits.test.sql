-- supabase/tests/0008_rate_limits.test.sql
--
-- Manual database test for check_rate_limit's core behavior (limits,
-- per-user isolation, per-action isolation, no-session handling). NOT
-- run by `npm test` (needs Postgres). Requires 0001, 0008, AND 0009
-- applied (0009 changed the function to a 2-argument signature — see
-- supabase/tests/0009_rate_limit_hardening.test.sql for the hardening-
-- specific scenarios: arbitrary actions, oversized limits, direct-RPC
-- abuse).
--
--   psql "$DATABASE_URL" -f supabase/tests/0008_rate_limits.test.sql
--
-- It creates fixture users, so run it only on a throwaway DB. Each block
-- prints what it expects; there is no automatic pass/fail.

\set ON_ERROR_STOP on
insert into auth.users (id, email) values
 ('aaaaaaaa-0000-0000-0000-000000000001','alice@x'),('bbbbbbbb-0000-0000-0000-000000000002','bob@x');

-- ---- as Alice
begin; set local role authenticated; select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001', true);

\echo '1) first call: allowed=true, current_count=1'
select * from check_rate_limit('chat', 3);

\echo '2/3) two more calls within the limit: allowed=true, current_count=2 then 3'
select * from check_rate_limit('chat', 3);
select * from check_rate_limit('chat', 3);

\echo '4) fourth call exceeds limit=3: allowed=false, current_count=4'
select * from check_rate_limit('chat', 3);

\echo '5) a different action has its own independent counter: allowed=true, current_count=1'
select * from check_rate_limit('document_upload', 3);

commit;

-- ---- as Bob: must have a completely separate counter from Alice's,
-- even though Bob calls the same action name.
begin; set local role authenticated; select set_config('request.jwt.claim.sub','bbbbbbbb-0000-0000-0000-000000000002', true);

\echo '6) Bob''s first "chat" call is allowed (Alice''s exhausted counter does not leak): allowed=true, current_count=1'
select * from check_rate_limit('chat', 3);

\echo '7) Bob cannot see or affect Alice''s row directly (RLS: zero policies on rate_limits for authenticated)'
select count(*) as should_be_0 from rate_limits where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

commit;

-- ---- as anon / no session: fails closed rather than allowing unlimited calls
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '', true);
\echo '8) no session -> allowed=false, current_count=0'
select * from check_rate_limit('chat', 3);
commit;
