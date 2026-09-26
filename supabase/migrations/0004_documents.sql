-- 0004_documents.sql
-- Phase 3: document upload + bounded document context (NOT retrieval/RAG —
-- see docs/ARCHITECTURE.md "Document context strategy (Phase 3)").

-- ---------------------------------------------------------------------------
-- documents
-- One row per successfully-processed upload. A document that fails
-- extraction is never inserted (see lib/documents/*), so there is no
-- 'failed' row to clean up — extraction_status exists for forward
-- compatibility with an async pipeline in a later phase, but Phase 3's
-- synchronous flow only ever writes 'ready'.
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  -- Path in the private 'documents' storage bucket. Null if the original
  -- file couldn't be preserved (storage upload is best-effort; extracted
  -- text is the field the app actually depends on — see ARCHITECTURE.md).
  storage_path text,
  extracted_text text not null,
  extraction_status text not null default 'ready' check (extraction_status in ('ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.documents is 'Uploaded documents with server-extracted text. Phase 3: no embeddings, no chunking.';
comment on column public.documents.storage_path is 'Path within the private "documents" storage bucket; null if the original file was not preserved.';

create index if not exists documents_user_id_created_at_idx
  on public.documents (user_id, created_at desc);

drop trigger if exists set_updated_at on public.documents;
create trigger set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

drop policy if exists "documents_select_own" on public.documents;
create policy "documents_select_own"
  on public.documents for select
  using (auth.uid() = user_id);

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own"
  on public.documents for insert
  with check (auth.uid() = user_id);

drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own"
  on public.documents for delete
  using (auth.uid() = user_id);

-- No update policy: documents are immutable once uploaded in Phase 3
-- (re-processing would mean re-uploading). Add one explicitly if a
-- future phase needs in-place reprocessing.

-- ---------------------------------------------------------------------------
-- conversation_documents
-- A document can be attached to more than one conversation, so this is a
-- separate join table rather than a column on either side. user_id is
-- denormalized (same pattern as messages) so RLS never needs a join.
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_documents (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, document_id)
);

comment on table public.conversation_documents is 'Which documents have been used in which conversations. Extracted text is never duplicated here.';

create index if not exists conversation_documents_conversation_id_idx
  on public.conversation_documents (conversation_id);

alter table public.conversation_documents enable row level security;

drop policy if exists "conversation_documents_select_own" on public.conversation_documents;
create policy "conversation_documents_select_own"
  on public.conversation_documents for select
  using (auth.uid() = user_id);

-- Insert requires the caller to already own both the conversation and the
-- document — this is what actually prevents attaching someone else's
-- document (or attaching to someone else's conversation) even though the
-- client only ever sends IDs.
drop policy if exists "conversation_documents_insert_own" on public.conversation_documents;
create policy "conversation_documents_insert_own"
  on public.conversation_documents for insert
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
    and exists (select 1 from public.documents d where d.id = document_id and d.user_id = auth.uid())
  );

drop policy if exists "conversation_documents_delete_own" on public.conversation_documents;
create policy "conversation_documents_delete_own"
  on public.conversation_documents for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- messages.metadata
-- Records which document (if any) a user message was asked alongside,
-- without duplicating the document's extracted text into every message.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists metadata jsonb;

comment on column public.messages.metadata is
  'Small, structured extras for a message. Phase 3 usage: {"documentId": uuid, "filename": text} when the user attached a document. Never stores document text.';

-- ---------------------------------------------------------------------------
-- Private storage bucket for original uploaded files.
-- Never public; access is via user-scoped paths + the policies below.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 5242880)
on conflict (id) do nothing;

drop policy if exists "documents_bucket_select_own" on storage.objects;
create policy "documents_bucket_select_own"
  on storage.objects for select
  using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "documents_bucket_insert_own" on storage.objects;
create policy "documents_bucket_insert_own"
  on storage.objects for insert
  with check (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "documents_bucket_delete_own" on storage.objects;
create policy "documents_bucket_delete_own"
  on storage.objects for delete
  using (bucket_id = 'documents' and auth.uid()::text = (storage.foldername(name))[1]);

-- Storage paths are always written as `${user_id}/${document_id}/${safeName}`
-- (see lib/documents/storage.ts), so `(storage.foldername(name))[1]` — the
-- first path segment — is always the owning user's ID, never a raw,
-- attacker-controlled filename.
