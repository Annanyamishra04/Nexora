-- 0006_rag_documents_update.sql
--
-- Fixes a Phase 4 RLS gap: Phase 3 (0004_documents.sql) intentionally
-- defined no UPDATE policy on public.documents, since documents were
-- immutable once uploaded. Phase 4's embedding pipeline
-- (lib/rag/pipeline.ts) now legitimately needs to UPDATE a document's own
-- row after chunking/embedding to set extraction_status, embedding_model,
-- embedding_dimensions, chunk_count, and processing_error — and, without
-- an UPDATE policy, RLS silently blocks all of those (rows_affected = 0,
-- no error), leaving a document stuck in 'processing' forever even though
-- its chunks were stored successfully.
--
-- This adds exactly the missing policy — narrowly scoped to a user's own
-- rows, both for reading which row may be updated (`using`) and for what
-- the updated row is allowed to look like afterward (`with check`) — and
-- nothing else. No other Phase 3 policy is touched.
drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own"
  on public.documents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on policy "documents_update_own" on public.documents is
  'Phase 4: allows lib/rag/pipeline.ts to update extraction_status/embedding_model/embedding_dimensions/chunk_count/processing_error on a document the caller owns. auth.uid() = user_id in both USING and WITH CHECK means a user can only ever update their own row, and can never (via this or any other policy) change a row''s user_id to someone else''s, since the post-update row must still satisfy user_id = auth.uid().';
