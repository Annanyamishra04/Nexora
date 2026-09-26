-- supabase/tests/0007_conversation_search.test.sql
--
-- Manual database test for migration 0007 (search_conversations) and the
-- RLS behaviour Phase 5 depends on. NOT run by `npm test` (needs Postgres).
--
-- Run against a scratch database that has migrations 0001–0004 and 0007
-- applied (a local `supabase start` DB works; so does plain PostgreSQL 16
-- with a stubbed `auth` schema: auth.users(id, email) and
-- auth.uid() reading current_setting('request.jwt.claim.sub')):
--
--   psql "$DATABASE_URL" -f supabase/tests/0007_conversation_search.test.sql
--
-- It creates fixture rows for two users, so run it only on a throwaway DB.
-- Each block prints what it expects; there is no automatic pass/fail.
-- Verified on PostgreSQL 16 during Phase 5 development.
\set ON_ERROR_STOP on
-- fixtures (as superuser)
insert into auth.users (id, email) values
 ('aaaaaaaa-0000-0000-0000-000000000001','alice@x'),('bbbbbbbb-0000-0000-0000-000000000002','bob@x');
insert into conversations (id, user_id, title, updated_at) values
 ('c1000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Explain RAG with an example', now() - interval '3 hour'),
 ('c2000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','Trip planning', now() - interval '2 hour'),
 ('c3000000-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','100% coverage_notes', now() - interval '1 hour'),
 ('c4000000-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000002','Bob secret RAG plans', now());
insert into messages (conversation_id, user_id, role, content, created_at) values
 ('c2000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','user','Can you regenerate the itinerary for Lisbon?', now() - interval '2 hour'),
 ('c2000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','assistant','Sure, here is a Lisbon itinerary with fado and pastel de nata.', now() - interval '110 minute'),
 ('c4000000-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000002','user','bobsecretword lisbon regenerate', now());

-- ---- as Alice
begin; set local role authenticated; select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001', true);
\echo '1) title substring "rag" -> only Alice conv 1 (NOT Bob''s RAG conversation)'
select title, match_type from search_conversations('rag');
\echo '2) message prefix "regen" -> Trip planning via message (NOT Bob''s message)'
select title, match_type, snippet from search_conversations('regen');
\echo '3) multi-word AND: "lisbon itinerary" -> Trip planning'
select title, match_type from search_conversations('lisbon itinerary');
\echo '4) Bob-only word "bobsecretword" -> nothing'
select count(*) as should_be_0 from search_conversations('bobsecretword');
\echo '5) wildcard escaping: "100%" matches only literal 100%'
select title from search_conversations('100%');
\echo '6) wildcard escaping: "%%" must not match everything'
select count(*) as should_be_0 from search_conversations('%%');
\echo '7) underscore literal: "e_n" matches "coverage_notes"; "e?n" style must not'
select title from search_conversations('e_n');
\echo '8) tsquery injection attempts do not error'
select count(*) from search_conversations('lisbon & | ! ( ) :* <-> foo');
select count(*) from search_conversations('''; drop table messages; --');
select count(*) from search_conversations('!!');
\echo '9) too-short query -> nothing'
select count(*) as should_be_0 from search_conversations('a');
\echo '10) limit honoured: "an" matches 2 conversations; limit 1 -> exactly 1'
select count(*) as should_be_1 from search_conversations('an', 1);
select count(*) as should_be_2 from search_conversations('an', 20);
rollback;

-- ---- unauthenticated (anon claim absent)
begin; set local role authenticated; select set_config('request.jwt.claim.sub','', true);
\echo '11) no auth.uid() -> nothing'
select count(*) as should_be_0 from search_conversations('rag');
rollback;

-- ---- as Bob: sees only own
begin; set local role authenticated; select set_config('request.jwt.claim.sub','bbbbbbbb-0000-0000-0000-000000000002', true);
\echo '12) Bob searching "rag" sees only his own'
select title from search_conversations('rag');
\echo '13) Bob searching Alice''s "itinerary" gets nothing'
select count(*) as should_be_0 from search_conversations('itinerary');
rollback;

-- From here on, statements are EXPECTED to fail (RLS violations), so don't abort the script.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
insert into documents (id, user_id, filename, mime_type, size_bytes, extracted_text) values
 ('d1000000-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001','notes.txt','text/plain',10,'hello');
insert into conversation_documents (conversation_id, document_id, user_id) values
 ('c2000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001');
\echo '=== BOB attacking ALICE ==='
begin; set local role authenticated;
select set_config('request.jwt.claim.sub','bbbbbbbb-0000-0000-0000-000000000002', true) \gset
\echo '[rename Alice conv as Bob -> expect UPDATE 0]'
update conversations set title='pwned' where id='c2000000-0000-0000-0000-000000000002';
\echo '[delete Alice conv as Bob -> expect DELETE 0]'
delete from conversations where id='c2000000-0000-0000-0000-000000000002';
\echo '[delete Alice messages as Bob -> expect DELETE 0]'
delete from messages where conversation_id='c2000000-0000-0000-0000-000000000002';
\echo '[insert into Alice conv as Bob -> expect RLS ERROR]'
insert into messages (conversation_id, user_id, role, content) values ('c2000000-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','user','x');
\echo '[insert forging Alice user_id as Bob -> expect RLS ERROR]'
insert into messages (conversation_id, user_id, role, content) values ('c2000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','user','x');
\echo '[delete Alice conversation_documents as Bob -> expect DELETE 0]'
delete from conversation_documents where conversation_id='c2000000-0000-0000-0000-000000000002';
rollback;

\echo '=== ALICE on own data ==='
begin; set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001', true) \gset
\echo '[messages have NO update policy -> expect UPDATE 0]'
update messages set content='tampered' where conversation_id='c2000000-0000-0000-0000-000000000002';
\echo '[rename own -> expect UPDATE 1]'
update conversations set title='Renamed' where id='c2000000-0000-0000-0000-000000000002';
\echo '[delete own messages (edit-style tail delete; fixture has 2) -> expect DELETE 2]'
delete from messages where conversation_id='c2000000-0000-0000-0000-000000000002';
\echo '[delete own conversation -> expect DELETE 1]'
delete from conversations where id='c2000000-0000-0000-0000-000000000002';
\echo '[conversation_documents cascaded -> expect 0]'
select count(*) from conversation_documents where conversation_id='c2000000-0000-0000-0000-000000000002';
\echo '[document itself preserved -> expect 1]'
select count(*) from documents where id='d1000000-0000-0000-0000-00000000000d';
commit;
