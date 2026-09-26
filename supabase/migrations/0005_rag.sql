-- 0005_rag.sql
-- Phase 4: real retrieval-augmented generation. Replaces Phase 3's
-- deterministic beginning-of-document truncation (see
-- docs/ARCHITECTURE.md "Document context in chat (Phase 3 — not RAG)")
-- with chunking + embeddings + pgvector similarity search.

-- ---------------------------------------------------------------------------
-- pgvector
-- ---------------------------------------------------------------------------
create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- documents: extend extraction_status and add embedding bookkeeping columns.
--
-- Phase 3 only ever wrote 'ready' or 'failed'. Phase 4 needs a third state:
-- a document whose text has been extracted but whose chunks/embeddings
-- haven't (yet) been successfully stored. We intentionally do NOT add a
-- separate 'uploaded' state — extraction and embedding both happen
-- synchronously within the same upload request (no background workers, per
-- the free-tier deployment constraint — see "Deployment strategy"), so
-- there is no user-visible gap between "uploaded" and "processing" for a
-- fresh upload to occupy. See docs/ARCHITECTURE.md "Document processing
-- status (Phase 4)".
-- ---------------------------------------------------------------------------
alter table public.documents drop constraint if exists documents_extraction_status_check;
alter table public.documents
  add constraint documents_extraction_status_check
  check (extraction_status in ('processing', 'ready', 'failed'));

-- New rows start 'processing' (chunking/embedding hasn't run yet), not
-- Phase 3's 'ready' default — see lib/documents/upload-flow.ts, which
-- also sets this explicitly on every insert; the column default is kept
-- in sync purely for schema-level correctness.
alter table public.documents alter column extraction_status set default 'processing';

alter table public.documents
  add column if not exists embedding_model text,
  add column if not exists embedding_dimensions integer,
  add column if not exists chunk_count integer not null default 0,
  add column if not exists processing_error text;

comment on column public.documents.embedding_model is
  'The GEMINI_EMBEDDING_MODEL value used to embed this document''s chunks. Null until embedding succeeds at least once.';
comment on column public.documents.embedding_dimensions is
  'Vector length used for this document''s chunks (must match document_chunks.embedding''s declared dimension).';
comment on column public.documents.chunk_count is
  'Number of rows currently in document_chunks for this document. 0 means not (yet) retrievable.';
comment on column public.documents.processing_error is
  'Safe, user-facing message describing the most recent embedding failure. Null when extraction_status is not ''failed''.';

-- Phase 3 rows were written with extraction_status='ready' but have no
-- chunks (chunking didn't exist yet). Without this backfill they would
-- silently look "ready" for RAG while being unretrievable. Moving them to
-- 'processing' surfaces them through the same "not ready yet" UI path as a
-- genuinely in-progress document, and makes them eligible for the
-- reprocess endpoint (see lib/rag/pipeline.ts, app/api/documents/[id]/reprocess).
update public.documents
  set extraction_status = 'processing'
  where extraction_status = 'ready' and chunk_count = 0;

-- ---------------------------------------------------------------------------
-- document_chunks
--
-- Vector dimension: 768. Both currently-supported Gemini embedding models
-- (gemini-embedding-001, gemini-embedding-2) are trained with Matryoshka
-- Representation Learning and support truncating their native
-- 3072-dimension output down to a smaller, still-useful size via
-- `output_dimensionality`; Google explicitly recommends 768, 1536, or 3072.
-- 768 is chosen here (not the 3072 default) to keep row/index size small
-- for a free-tier Postgres instance while remaining on Google's
-- recommended list — see lib/rag/config.ts and
-- docs/ARCHITECTURE.md "Embedding provider (Phase 4)" for the full
-- reasoning. If GEMINI_EMBEDDING_DIMENSIONS is ever changed, this column's
-- declared dimension must be updated in a new migration to match — pgvector
-- enforces the declared width at insert time, so a mismatch fails loudly
-- rather than silently corrupting similarity search.
-- ---------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  -- Denormalized from documents.user_id (same pattern as messages /
  -- conversation_documents) so RLS and the match_document_chunks RPC below
  -- never need a join to enforce ownership.
  user_id uuid not null references auth.users (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

comment on table public.document_chunks is
  'Chunked, embedded document text used for RAG retrieval. A document is only retrievable once its chunks are fully stored (documents.extraction_status = ''ready'').';
comment on column public.document_chunks.metadata is
  'Small structured extras for citations: at minimum {"filename": text, "contentType": text}. Never invented — always derived from the parent document row. See lib/rag/pipeline.ts.';

create index if not exists document_chunks_document_id_idx
  on public.document_chunks (document_id);

create index if not exists document_chunks_user_id_idx
  on public.document_chunks (user_id);

-- Similarity index. HNSW (not IVFFlat) is chosen deliberately: IVFFlat's
-- "lists" parameter needs to be sized against the eventual row count and
-- re-tuned as data grows, which doesn't fit a small, continuously-growing
-- free-tier dataset with no maintenance job to rebuild it. HNSW builds
-- incrementally with reasonable defaults and no row-count tuning, at the
-- cost of somewhat slower inserts — an acceptable trade for this app's
-- scale (see docs/ARCHITECTURE.md "Vector index (Phase 4)").
--
-- vector_cosine_ops: cosine distance, matching the similarity metric used
-- throughout (Gemini's own documentation recommends cosine similarity for
-- its embeddings — see lib/rag/embedding-provider.ts).
create index if not exists document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks enable row level security;

drop policy if exists "document_chunks_select_own" on public.document_chunks;
create policy "document_chunks_select_own"
  on public.document_chunks for select
  using (auth.uid() = user_id);

-- Insert requires the caller to already own the parent document — this is
-- what actually prevents writing chunks under someone else's document_id,
-- even though the client (in practice, only server-side code using the
-- request-scoped/user-authenticated Supabase client — this app never uses
-- the service role) only ever supplies document_id.
drop policy if exists "document_chunks_insert_own" on public.document_chunks;
create policy "document_chunks_insert_own"
  on public.document_chunks for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );

drop policy if exists "document_chunks_delete_own" on public.document_chunks;
create policy "document_chunks_delete_own"
  on public.document_chunks for delete
  using (auth.uid() = user_id);

-- No update policy: a chunk is never edited in place. Reprocessing deletes
-- and re-inserts (see lib/rag/pipeline.ts), so no UPDATE right is needed.

-- ---------------------------------------------------------------------------
-- match_document_chunks: the one and only way chunk similarity search
-- happens. SECURITY INVOKER (the default) — it runs with the caller's own
-- privileges, so document_chunks' RLS policies above apply exactly as they
-- would to any other query. The explicit `dc.user_id = auth.uid()`
-- predicate below is deliberate belt-and-braces: ownership is enforced
-- independently of RLS being present/enabled, per the requirement that the
-- database function itself — not just the API route — must not allow one
-- user to retrieve another user's chunks by supplying a different
-- document_id.
-- ---------------------------------------------------------------------------
create or replace function public.match_document_chunks(
  query_embedding vector(768),
  match_count integer default 6,
  filter_document_ids uuid[] default null
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  metadata jsonb,
  similarity float8
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    -- pgvector's <=> is cosine *distance* (0 = identical, 2 = opposite);
    -- convert to a similarity score in [-1, 1] (1 = identical) so callers
    -- can apply RAG_SIMILARITY_THRESHOLD as a plain "higher is better" cut.
    1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  where dc.user_id = auth.uid()
    and (filter_document_ids is null or dc.document_id = any (filter_document_ids))
  order by dc.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 6), 1), 50);
$$;

comment on function public.match_document_chunks is
  'Cosine-similarity search over document_chunks, hard-scoped to auth.uid() regardless of filter_document_ids. Callers additionally pass only document IDs the requesting user is known to own (see lib/rag/retrieval.ts) as defense in depth, but this function does not trust that alone.';

-- Callers reach this only through the request-scoped Supabase client
-- (never the service role, consistent with the rest of this app), so it
-- only ever needs to be reachable by the standard authenticated role.
grant execute on function public.match_document_chunks(vector, integer, uuid[]) to authenticated;
