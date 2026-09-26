# Nexora

A workspace for AI conversations grounded in your own documents.

**Phase 1** built the architecture, database, auth, and UI shell.
**Phase 2** turned the chat UI into a real, working AI chatbot: real
Gemini streaming, persisted conversations, retry, and markdown
rendering. **Phase 3** added document upload and a bounded,
non-embeddings document-context strategy. **Phase 4** (this update)
replaces that bounded-context strategy with real retrieval-augmented
generation: documents are chunked, embedded with Gemini, and stored in
Supabase Postgres via `pgvector`; chat answers are grounded in
similarity-searched chunks instead of a fixed slice of the document, and
responses show real, server-derived source citations.

See [Current scope](#current-phase-4-scope) below for exactly what
works today and what's still deferred.

## Tech stack

- [Next.js 14](https://nextjs.org) (App Router) + TypeScript (strict)
- [Tailwind CSS](https://tailwindcss.com) with a hand-tuned design token set
- [Supabase](https://supabase.com) — Postgres, Auth, Storage, and `pgvector`
- [Google Gemini](https://ai.google.dev) (`@google/genai`) for AI responses and embeddings, via swappable provider interfaces
- [Zod](https://zod.dev) for input validation
- [react-markdown](https://github.com/remarkjs/react-markdown) for safe (non-`dangerouslySetInnerHTML`) Markdown rendering
- [unpdf](https://github.com/unjs/unpdf) for PDF text extraction (maintained, zero required native dependencies — safe on serverless)
- [mammoth](https://github.com/mwilliamson/mammoth.js) for DOCX text extraction
- [lucide-react](https://lucide.dev) for icons
- [Vitest](https://vitest.dev) for unit tests
- No Redis, no background workers, no Docker, no OCR, no separate vector
  database service — deploys to Vercel's free tier alongside Supabase's
  free tier; embedding runs synchronously in the upload/reprocess request

## Local setup

```bash
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and GEMINI_API_KEY
npm run dev
```

The app builds and starts even without any of these set. Auth and
database-backed pages will error at request time without Supabase
credentials; `/api/chat` and `/api/documents` return a clear
configuration/auth error (not a crash) without the right environment
set up.

## Environment variables

See `.env.example` for the full list with inline comments.

| Variable | Exposed to browser? | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Public anon key (RLS-scoped, safe to expose) |
| `GEMINI_API_KEY` | **No** | Required for real AI responses and embeddings. Create one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | **No** | Optional. Defaults to `gemini-flash-latest`. Set to pin an exact chat model version. |
| `GEMINI_EMBEDDING_MODEL` | **No** | Optional. Defaults to `gemini-embedding-001`. See `docs/ARCHITECTURE.md` "Embedding provider (Phase 4)". |
| `GEMINI_EMBEDDING_DIMENSIONS` | **No** | Optional. Defaults to `768`. Must match the `vector(768)` column in `supabase/migrations/0005_rag.sql` if changed. |
| `RAG_CHUNK_MAX_CHARS`, `RAG_CHUNK_OVERLAP_CHARS`, `RAG_CHUNK_MIN_CHARS` | **No** | Optional chunking tunables. See `docs/ARCHITECTURE.md` "RAG configuration defaults (Phase 4)". |
| `RAG_EMBEDDING_BATCH_SIZE` | **No** | Optional. Chunks embedded per Gemini request. Defaults to `16`. |
| `RAG_TOP_K`, `RAG_SIMILARITY_THRESHOLD`, `RAG_MAX_CONTEXT_CHARS`, `RAG_MAX_CHARS_PER_CHUNK` | **No** | Optional retrieval tunables. See `docs/ARCHITECTURE.md`. |
| `RATE_LIMIT_CHAT_PER_MINUTE` | **No** | Optional. Defaults to `20`. Max `/api/chat` requests per authenticated user per minute. |
| `RATE_LIMIT_UPLOAD_PER_HOUR` | **No** | Optional. Defaults to `30`. Max document upload/reprocess requests per authenticated user per hour. |
| `RATE_LIMIT_SEARCH_PER_MINUTE` | **No** | Optional. Defaults to `60`. Max conversation search requests per authenticated user per minute. |

Every variable above is also listed as data in `lib/env.ts` (`ENV_SPEC`), which is what `instrumentation.ts` checks on server boot — see "Phase 6 — production hardening" below.

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Copy the project URL and anon key into `.env.local`.
3. Run the migrations (either via the SQL editor or the CLI):

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   This applies, in order:

   - `supabase/migrations/0001_initial_schema.sql` — `profiles`,
     `conversations`, `messages`, an `updated_at` trigger, and a trigger
     that creates a `profiles` row for every new auth user.
   - `supabase/migrations/0002_rls_policies.sql` — Row Level Security
     policies so one user can never read or write another user's rows.
   - `supabase/migrations/0003_message_status.sql` — adds
     `messages.status` (`'complete' | 'incomplete'`) so a reply cut off
     mid-generation is recorded honestly rather than silently treated as
     finished.
   - `supabase/migrations/0004_documents.sql` — adds `documents` and
     `conversation_documents` tables, `messages.metadata`, and creates a
     **private** `documents` Storage bucket with owner-scoped RLS
     policies on `storage.objects`.
   - `supabase/migrations/0005_rag.sql` — enables the `pgvector`
     extension; adds a `'processing'` `documents.extraction_status`
     value plus embedding bookkeeping columns (with a backfill for
     pre-existing Phase 3 rows); adds the `document_chunks` table (RLS
     enabled, HNSW cosine index); and adds the `match_document_chunks`
     SQL function used for all similarity search, which enforces
     ownership independently of the API layer. See
     `docs/ARCHITECTURE.md` "RAG architecture (Phase 4)" for the full
     reasoning behind every choice in this migration.
   - `supabase/migrations/0006_rag_documents_update.sql` — adds the
     missing `documents` UPDATE policy (scoped to `auth.uid()`) that
     Phase 4's embedding pipeline needs to set `extraction_status` etc.
     on a user's own document row.
   - `supabase/migrations/0007_conversation_search.sql` — a full-text
     index on `messages` and the `search_conversations` RPC for the
     Conversations page's search bar. Adds no tables, columns, or
     policies.
   - `supabase/migrations/0008_rate_limits.sql` — Phase 6: the
     `rate_limits` table (RLS enabled, no client-facing policies) and
     the `check_rate_limit` SQL function used for lightweight,
     database-backed rate limiting. See "Phase 6 — production hardening"
     below.
   - `supabase/migrations/0009_rate_limit_hardening.sql` — **required**,
     not optional: hardens the `check_rate_limit` RPC surface itself
     (defense-in-depth, independent of how the app's own routes call
     it). Restricts `action` to the three values the app actually uses
     via a table `CHECK` constraint; fixes `window_seconds` server-side
     per action (removed as a caller-suppliable argument entirely); and
     clamps the caller-supplied `limit` to the same `<= 1000` ceiling
     already enforced on every `RATE_LIMIT_*` env var, so a direct RPC
     call can never request a larger limit than the app would
     legitimately configure for itself. `auth.uid()`-scoped ownership
     and all other 0008 guarantees are preserved unchanged. See the
     comment at the top of the migration file for the full rationale.

4. In your Supabase project's Auth settings, decide whether email
   confirmation is required. The signup flow handles both cases: if
   confirmation is on, the user is told to check their email instead of
   being redirected into the app.

## Migrations

Migrations are plain, ordered SQL files — no separate migration tool.
Add new ones as `supabase/migrations/000N_description.sql` and apply with
`supabase db push`.

## Development commands

```bash
npm run dev      # start the dev server
npm test         # run the unit test suite (vitest)
npm run lint     # ESLint
npm run build    # production build
npm run start    # run the production build locally
```

## Architecture overview

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full
breakdown: routes, component boundaries, the Supabase/auth setup,
database model, RLS policies, the Gemini chat and embedding provider
abstractions, streaming protocol, message persistence, context-window
strategy, retry semantics, document upload/extraction, the storage
decision, the full Phase 4 RAG architecture (chunking, embeddings,
pgvector, retrieval scope, top-K/threshold/context budget, source
citations, failure/retry handling), and prompt-injection handling.

## Current Phase 4 scope

**Implemented and functional:**

- Everything from Phase 1–3 (auth, RLS, real streamed Gemini chat,
  persistence, retry, markdown, document upload/extraction/deletion) —
  unchanged.
- Real retrieval-augmented generation for document Q&A: uploaded
  documents are chunked (`lib/rag/chunk.ts`), embedded with Gemini
  (`lib/rag/embedding-provider.ts`), and stored in Supabase Postgres via
  `pgvector` (`document_chunks`), all synchronously during upload — no
  background workers.
- Semantic similarity search (`match_document_chunks`, cosine distance,
  HNSW index) scoped to the current conversation's attached, ready
  documents — not the user's entire document library — with a
  configurable top-K and minimum-similarity threshold
  (`lib/rag/retrieval.ts`).
- Real source citations: every assistant reply grounded in retrieved
  chunks shows a compact, expandable "Sources" list (filename + chunk
  index, with the actual retrieved passage on demand) — built entirely
  from what the server retrieved, never parsed or trusted from the
  model's own reply text.
- A document processing status (`processing` / `ready` / `failed`) shown
  on the Files page, with a "Retry processing" action that re-embeds an
  already-extracted document via `POST /api/documents/[id]/reprocess`
  without needing to re-upload the file.
- Graceful degradation: normal chat (no documents attached) is completely
  unaffected — no embedding calls happen at all unless a conversation has
  a ready document attached; a transient embedding-provider failure
  during retrieval degrades one turn rather than breaking the chat
  request.
- Document content — and now retrieved chunk content — is treated as
  untrusted data, delimited and never merged into the system instruction
  — see "Prompt injection defense (Phase 4)" in `docs/ARCHITECTURE.md`.

**Intentionally deferred:**

- Page-aware citations (this codebase's PDF extraction doesn't currently
  track per-page text boundaries — see "Known limitations (Phase 4)")
- OCR for scanned documents
- Reranking, hybrid (keyword + vector) search
- Voice, image generation, multi-agent features, collaboration, billing

## Phase 5 — conversation experience

Built on top of Phases 1–4 (no rewrite). Details in `docs/ARCHITECTURE.md` → "Conversation UX (Phase 5)".

- **Regenerate** — the latest assistant reply can be regenerated. It goes through the same `/api/chat` pipeline (same history, RAG retrieval, Gemini call). The old reply is kept until the new one is saved, so a failed or stopped regeneration never loses it.
- **Edit + resend** — a user can edit their own earlier message. The conversation is truncated from that message onward and the edited text is answered (no branching).
- **Conversations page** — search (titles + message text), inline rename, and delete with confirmation.
- **Message actions** — Copy, Edit, Regenerate, Sources; keyboard accessible, always visible on touch devices.
- **Migration `0007_conversation_search.sql`** — a full-text index on `messages` and the `search_conversations` RPC. Adds no tables, columns, or policies. Apply it like the earlier migrations.

## Phase 6 — production hardening + deployment readiness

Built on top of Phases 1–5 (no rewrite, no removed features). Focus: making Nexora safe and configurable to actually deploy, not new user-facing capability.

- **Settings page** — now has Profile (unchanged), a read-only **AI preferences** section (shows the effective chat model and whether `GEMINI_API_KEY` is configured — never editable from the client, since the model is intentionally server-controlled; see "AI provider hardening" below), Account, a **Data** section (explains what's stored and offers a real, confirmed "delete all my data" action — removes all of the caller's conversations/messages/documents, not the auth account itself), and Security (sign-out, last sign-in time).
- **Environment validation (`lib/env.ts`, `instrumentation.ts`)** — a single source of truth for every environment variable (required vs. optional, with documented defaults). `instrumentation.ts` runs once per server process and throws clearly in production if `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing; local development stays lenient (warns instead), matching the existing per-request `GEMINI_API_KEY` behavior in `lib/ai/gemini.ts`.
- **Rate limiting (`supabase/migrations/0008_rate_limits.sql`, hardened by `0009_rate_limit_hardening.sql`, `lib/rate-limit.ts`)** — lightweight, database-backed abuse protection with no external service (no Redis/Upstash). A `check_rate_limit` SQL function does an atomic fixed-window increment, `SECURITY DEFINER` but hard-scoped to `auth.uid()` regardless of arguments, so it's impossible for one caller to read or affect another user's counters — this is what makes it safe to expose to the `authenticated` role even though the underlying `rate_limits` table has zero client-facing RLS policies. Scoped to authenticated users (never IP-only), applied to `POST /api/chat`, `POST /api/documents`, `POST /api/documents/[id]/reprocess`, and `GET /api/conversations/search`. Configurable via `RATE_LIMIT_CHAT_PER_MINUTE` / `RATE_LIMIT_UPLOAD_PER_HOUR` / `RATE_LIMIT_SEARCH_PER_MINUTE` (see `.env.example`); on a database error the check fails **closed** (rejects the request with a `503` and a machine-readable `rate_limit_unavailable` code) rather than silently letting requests through unmetered — see the Phase 6 correction note in `lib/rate-limit.ts`. A real over-limit caller instead gets a clean `429` with a machine-readable `rate_limited` code and a `Retry-After` header. **`0009_rate_limit_hardening.sql` is required** on top of 0008, not optional: it hardens the RPC surface itself so a client calling `check_rate_limit` directly (bypassing the app's routes, using the same anon key + session JWT already present client-side) can no longer supply an arbitrary `action` string (now restricted by a table `CHECK` constraint to the three actions the app uses), an arbitrary window (now fixed server-side per action, no longer a caller-suppliable argument), or an oversized `limit` (now clamped to `<= 1000`, the same ceiling already enforced on every `RATE_LIMIT_*` env var). `auth.uid()`-scoped ownership is unchanged.
- **Security headers (`next.config.mjs`)** — `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a `Permissions-Policy` disabling camera/microphone/geolocation. No Content-Security-Policy was added — see the comment in `next.config.mjs` for why (the existing UI/streaming/auth flow was not audited against one, and a wrong CSP silently breaks things).
- **AI provider hardening review** — confirmed (already true from Phase 2, re-verified here): `GEMINI_API_KEY` is server-only, `GEMINI_MODEL` is read only from the server environment (never from a request body), and provider errors are already normalized (`lib/chat/errors.ts`) so internal messages never reach the client.
- **RAG/database security audit** — reviewed every migration (`0001`–`0007`), every RLS policy, and both `SECURITY {INVOKER,DEFINER}` SQL functions. No issues found: every table is scoped to `auth.uid()`, `match_document_chunks` and `search_conversations` are `SECURITY INVOKER` with belt-and-braces ownership predicates, and the storage bucket policies correctly derive ownership from the object path. `0008_rate_limits.sql`, later hardened by `0009_rate_limit_hardening.sql` (see below), are the new migrations this phase produced.
- **Tests** — `lib/env.test.ts`, `lib/rate-limit.test.ts`, `app/(app)/settings/actions.test.ts`, plus new rate-limit coverage inside `app/api/chat/route.test.ts` and `app/api/conversations/routes.test.ts`. Manual (non-`npm test`) pgTAP-style tests for the rate-limit RPC live at `supabase/tests/0008_rate_limits.test.sql` and `supabase/tests/0009_rate_limit_hardening.test.sql`, matching the existing `0007` test's convention.
- **Migration `0008_rate_limits.sql`** — adds the `rate_limits` table (RLS enabled, zero client-facing policies — reachable only via the function below) and the `check_rate_limit` SQL function. Apply it like the earlier migrations.
- **Migration `0009_rate_limit_hardening.sql`** — **required**, applied immediately after `0008`. Hardens the `check_rate_limit` RPC surface: restricts `action` to a fixed set via a table `CHECK` constraint, fixes the rate-limit window server-side per action (no longer a caller-suppliable argument), and clamps the caller-supplied `limit` to `<= 1000`, while preserving `auth.uid()`-scoped ownership and every other 0008 guarantee. See the migration file's header comment for the full threat model.

## Production deployment guide

A concise checklist; each step links to the fuller explanation above.

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (see "Supabase setup").
2. **Apply migrations in order**, `0001` through `0009`, via `supabase db push` or the SQL editor (see "Supabase setup" for what each one does). `0009_rate_limit_hardening.sql` is required, not optional — it hardens the `check_rate_limit` RPC surface (restricts valid actions, fixes the rate-limit window server-side, clamps the caller-supplied limit) while preserving `auth.uid()`-scoped ownership; do not stop at `0008`.
3. **Configure Storage** — migration `0004` creates the private `documents` bucket and its owner-scoped policies automatically; no manual Storage configuration is needed beyond the migrations running successfully.
4. **Configure Auth** — in the Supabase dashboard, decide whether email confirmation is required (both settings work with the existing signup flow).
5. **Create a Gemini API key** at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
6. **Set environment variables in Vercel** (Project Settings → Environment Variables, scoped to Production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GEMINI_API_KEY` at minimum — see "Environment variables" above for the full list and defaults. **Never** set a Supabase *service-role* key anywhere in this project; it is never used.
7. **Build and deploy** — `next build` (Vercel runs this automatically on push); `instrumentation.ts` will fail the boot clearly if `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing in production.
8. **Verify auth** — sign up, confirm (if enabled), sign in, sign out; confirm `/dashboard` redirects to `/login` when signed out.
9. **Verify chat** — send a message in a new conversation and confirm a real (not error) streamed reply.
10. **Verify document upload** — upload a small PDF/DOCX/TXT/MD file from the Files page and confirm it reaches `extraction_status: ready`.
11. **Verify RAG** — attach that document to a conversation and ask a question its content actually answers.
12. **Verify sources** — confirm the reply's "Sources" panel shows the filename and a retrieved excerpt, not an empty or error state.

**Local development** uses `.env.local` (see "Local setup") and intentionally tolerates missing configuration — the app starts and shows clear per-request errors instead of crashing. **Production** is stricter: `instrumentation.ts` fails the boot immediately if the two required Supabase variables aren't set, per "Phase 6 — production hardening" above.

## Known limitations

- `lib/supabase/types.ts` is hand-written. Regenerate it with the
  Supabase CLI once the schema grows:
  `npx supabase gen types typescript --project-id <id> > lib/supabase/types.ts`.
- Fonts use system font stacks (see `app/globals.css`) rather than a
  hosted webfont, so the app has zero external network dependency at
  build or runtime.
- A client disconnecting mid-stream is handled best-effort — see
  "Known limitations" in `docs/ARCHITECTURE.md` for why this can't be
  made fully reliable on a serverless runtime.
- Embedding runs synchronously within the upload/reprocess request (no
  background workers, per the free-tier deployment target) — a very
  large document can make that request slow, with only a "Processing…"
  status shown, no fine-grained progress.
- No page-aware citations yet (filename + chunk index only); see "Known
  limitations (Phase 4)" in `docs/ARCHITECTURE.md`.
- Character-based chunking approximates token count rather than counting
  it exactly (documented trade-off; see `lib/rag/chunk.ts`).
- Preserving the original uploaded file in Storage is best-effort; only
  the extracted text is guaranteed to be saved.
- Live Gemini/Supabase/Storage behavior — including real embedding calls
  — has not been exercised end-to-end in the sandbox this was built in
  (no network access to Google's or Supabase's APIs there). The code
  compiles, type-checks, and its pure logic (validation, extraction
  inputs, normalization, chunking, embedding-provider contract,
  retrieval scope/threshold/budget, prompt delimiting, ownership rules)
  is unit-tested with the embedding provider and Supabase client mocked;
  manual testing against a real `GEMINI_API_KEY` and Supabase project —
  including actually uploading real PDF/DOCX files and asking questions
  against them — is still needed before shipping.
- No end-to-end/integration tests against the `/api/chat` or
  `/api/documents` routes themselves — see `docs/ARCHITECTURE.md` for
  what is and isn't covered by the current test suite.
- Phase 6 scope note: sections 9 ("loading/empty/error states" audit
  across `/login`, `/signup`, `/dashboard`, `/chat`, `/conversations`,
  `/files`, `/settings`) and 11 (a centralized server error-logging
  helper) from the Phase 6 brief were not addressed in this pass — the
  existing per-route `console.error` calls (see `app/api/chat/route.ts`,
  `lib/documents/storage.ts`, etc.) were left as-is rather than
  consolidated. Rate limiting, environment validation, security headers,
  the settings-page additions, and the RAG/database security audit were
  completed and are covered by tests (see "Phase 6 — production
  hardening" above).
- The rate-limit fixed-window algorithm (`check_rate_limit`) can allow
  up to roughly 2x the nominal limit across a window boundary — an
  accepted, documented trade-off for a simple DB-backed limiter with no
  external service, unchanged by the `0009` hardening pass; see the
  comment at the top of `supabase/migrations/0008_rate_limits.sql` for
  the original design and `supabase/migrations/0009_rate_limit_hardening.sql`
  for the RPC-surface hardening applied on top of it.
