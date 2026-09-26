# Architecture

This document describes the foundation built across Phase 1 (project/DB/auth
foundation), Phase 2 (real Gemini chat + streaming), and Phase 3 (document
upload + bounded document context), and how each was designed so later
phases could extend it without a rewrite.

## Application structure

```
app/
  (auth)/                 # unauthenticated route group
    layout.tsx            # split-screen auth shell
    login/page.tsx
    signup/page.tsx
    actions.ts             # server actions: login, signup, logout
  (app)/                  # authenticated route group
    layout.tsx             # fetches user + recent conversations, renders AppShell
    dashboard/page.tsx
    chat/page.tsx           # loads an existing conversation's messages, or starts fresh
    conversations/page.tsx
    files/page.tsx
    settings/
      page.tsx
      actions.ts
  api/
    chat/route.ts           # POST — real Gemini streaming, see "Chat architecture"
    documents/
      route.ts               # GET (list) / POST (upload+extract), see "Document upload"
      [id]/route.ts            # DELETE — ownership-checked, best-effort storage cleanup
  layout.tsx               # root HTML shell
  page.tsx                  # "/" — redirects based on session
  globals.css               # design tokens + base styles
middleware.ts               # session refresh + server-side route protection
components/
  ui/                       # low-level primitives (Button, Input, EmptyState)
  layout/                   # AppShell, sidebar (+ recent conversations), nav, page header, user menu
  auth/                     # auth form
  chat/                     # Chat (streaming client), MessageBubble, Composer (+ attach picker), Markdown, CodeBlock
  files/                    # FilesView, FileUploader, DocumentRow
  settings/                 # profile form
lib/
  supabase/
    client.ts               # browser client
    server.ts                # server client (Server Components/Actions/Route Handlers)
    types.ts                 # hand-written Database type
  ai/
    provider.ts              # provider-agnostic AiProvider interface
    gemini.ts                 # Gemini implementation
    system-prompt.ts          # server-only system instruction
    document-prompt.ts        # bounded document context + safe delimiting (pure, tested)
  chat/
    title.ts                  # conversation title derivation (pure, tested)
    context.ts                 # context-window trimming (pure, tested)
    errors.ts                  # safe error mapping (pure, tested)
    ownership.ts                # retry validation (pure, tested)
  documents/
    limits.ts                  # client-safe size/extension constants (no Node APIs)
    validate.ts                 # server-only validation: size/type + magic-byte checks (pure, tested)
    normalize.ts                 # extracted-text cleanup (pure, tested)
    extract-text.ts               # per-format extraction (unpdf / mammoth / UTF-8)
    storage.ts                     # storage path generation + best-effort upload/delete (pure parts tested)
    upload-flow.ts                  # generates document ID, uploads, then inserts once — see "Storage decision" (tested)
    errors.ts                       # DocumentExtractionError + safe mapping
    format.ts                        # human-readable file size
  validation/                # zod schemas (auth, chat)
  utils.ts
supabase/migrations/
  0001_initial_schema.sql
  0002_rls_policies.sql
  0003_message_status.sql   # adds messages.status ("complete" | "incomplete")
  0004_documents.sql         # documents, conversation_documents, messages.metadata, storage bucket
docs/ARCHITECTURE.md
```

The two route groups — `(auth)` and `(app)` — exist purely for layout
separation; they don't affect URLs. `(app)/layout.tsx` is a Server
Component that resolves the user once per request and passes just the
email down to a client `AppShell`, keeping the interactive shell (mobile
drawer, user menu) as small a client boundary as possible.

## Server/client component boundaries

- **Server by default.** Every page under `(app)` is a Server Component
  that reads from Supabase directly with the server client. There is no
  client-side data fetching for anything that's rendered on load.
- **Client components are leaves.** `AppShell`, `AuthForm`, `Composer`,
  `UserMenu`, and the settings/profile form are client components because
  they need interactivity (state, event handlers) — everything above them
  stays a Server Component.
- **Mutations go through Server Actions**, not API routes or client-side
  Supabase calls. `login`, `signup`, `logout`, and `updateDisplayName` all
  run on the server, validate with Zod, and never leak raw database errors
  to the client.

## Supabase architecture

Two Supabase clients, matching the two runtimes:

- `lib/supabase/client.ts` — for Client Components, built with
  `createBrowserClient` from `@supabase/ssr`.
- `lib/supabase/server.ts` — for Server Components, Server Actions, and
  Route Handlers, built with `createServerClient`, reading/writing cookies
  via `next/headers`.

`middleware.ts` runs a third instance of the server client on every
request solely to refresh the session cookie (Server Components can read
but not write cookies) and to redirect unauthenticated requests away from
protected routes before any page code runs. No route relies on a
client-side redirect for protection.

The Supabase **service role key is never used** anywhere in this
codebase. Every read/write goes through the anon key and is authorized by
Postgres Row Level Security, not application logic.

## Database model (Phase 1)

Three tables, deliberately minimal:

- **`profiles`** — one row per `auth.users` row, created automatically by
  an `on_auth_user_created` trigger. Holds `display_name` today; this is
  the natural home for future account-level preferences.
- **`conversations`** — `user_id`, `title`, timestamps. A thread container;
  message generation isn't implemented yet, but the shape is ready.
- **`messages`** — `conversation_id`, a denormalized `user_id` (so RLS on
  messages doesn't need a join to `conversations`), `role`, `content`,
  and (since Phase 2) `status` (`'complete' | 'incomplete'`, added by
  `0003_message_status.sql`) marking whether an assistant reply finished
  generating cleanly or was cut off.

All primary keys are UUIDs (`gen_random_uuid()`). Every user-owned table
carries a `user_id` column referencing `auth.users(id)`, and every query
in application code is implicitly scoped by RLS — the app never adds its
own `WHERE user_id = ...` as the *only* safeguard.

Indexes: `conversations (user_id, updated_at desc)` for the conversation
list, `messages (conversation_id, created_at asc)` for reading a thread in
order, and `messages (user_id)` for RLS lookups.

## Row Level Security

RLS is enabled on all three tables in `0001`, with policies defined
separately in `0002` so schema and access-control changes are easy to
review independently. Every policy is written against `auth.uid()`:

- `profiles`: select/update own row only. No client-side insert/delete —
  rows are created by a `security definer` trigger and cascade-delete with
  the auth user.
- `conversations`: full CRUD, scoped to `user_id = auth.uid()`.
- `messages`: select/insert/delete scoped to `user_id = auth.uid()`; the
  insert policy additionally checks that the target conversation is also
  owned by the same user, so a message can never be attached to someone
  else's thread. There's intentionally no update policy yet — an "edit
  message" feature should add one explicitly rather than inherit broad
  update rights.

## Authentication architecture

Supabase Auth (email + password) via SSR/cookie sessions — no tokens in
`localStorage`, no custom session store. `signup` calls
`supabase.auth.signUp` and checks whether Supabase returned a session: if
email confirmation is required, the user sees a "check your email"
message instead of being redirected into a still-unauthenticated app
shell. `login`/`logout` are equally thin wrappers with Zod-validated
input and generic error messages (no leaking of "user not found" vs.
"wrong password", which would let an attacker enumerate emails).

Route protection is layered:

1. `middleware.ts` redirects unauthenticated requests to `/login` before
   any page code runs (and redirects an authenticated user away from
   `/login` / `/signup`).
2. `(app)/layout.tsx` re-checks `getUser()` server-side and redirects
   again if somehow reached without a session — defense in depth, not
   trust in the middleware alone.

## Future AI provider abstraction (Phase 2+)

Implemented in Phase 2. `lib/ai/provider.ts` defines a minimal
`AiProvider` interface (`streamReply({ systemInstruction, history }) ->
AsyncIterable<string>`); `lib/ai/gemini.ts` is the only implementation
today. `app/api/chat/route.ts` depends solely on the interface, so a
second provider (a fallback model, a different vendor) can be added
later without touching route logic — it would just need to satisfy the
same interface and be swapped in where `new GeminiProvider()` is
constructed.

The Gemini SDK client (`@google/genai`) is instantiated lazily and only
on the server; if `GEMINI_API_KEY` is missing, `getClient()` throws a
`config_error`-coded `ChatError` before any network call is attempted,
which the route maps to a safe, generic message for the client (see
"Error handling" below).

## Chat architecture (Phase 2)

**Route:** a single Route Handler, `POST /api/chat`, rather than a
Server Action — Server Actions in Next 14 don't give the client a
progressively-readable stream, and a real streaming reply is a hard
requirement here.

**Request shape:** `{ conversationId?, content? }` for a new message, or
`{ conversationId, retryMessageId }` to regenerate a reply without
resending the user's text (see "Retry" below). Validated with
`lib/validation/chat.ts` (`chatRequestSchema`) — content is trimmed,
must be 1–4000 characters, and content/retryMessageId are mutually
exclusive and individually required.

**Server flow** (all in `app/api/chat/route.ts`):

1. Parse and Zod-validate the body.
2. Resolve the user from `supabase.auth.getUser()` — the request body
   never carries a user id, and nothing from the client is trusted for
   identity.
3. New message: verify an existing `conversationId` belongs to the
   caller (or create a new conversation, titled via `deriveTitle()`),
   then insert the user's message.
   Retry: load the target message and everything after it, and run
   `validateRetryTarget()` (see "Retry" below) before proceeding — no
   new row is inserted for a retry.
4. Load the last `MAX_HISTORY_MESSAGES` rows for the conversation and
   reduce them with `buildGeminiHistory()` (see "Context-window
   strategy").
5. Return a `ReadableStream` response immediately, with
   `X-Conversation-Id` and `X-User-Message-Id` response headers set
   before any body bytes are written, so the client knows which
   conversation/message it's talking about even while the body is still
   streaming.
6. Inside the stream: call `GeminiProvider.streamReply()`, forwarding
   each text chunk to the client as an NDJSON line (`{"type":"chunk",...}`),
   accumulating the full text server-side.
7. On a clean finish, insert the assistant message with
   `status: "complete"`, bump `conversations.updated_at`, and emit a
   final `{"type":"done","messageId":...}` line.
8. On failure (Gemini error, provider timeout, etc.) or a client
   disconnect (`request.signal` aborts), see "Message persistence and
   failure handling" below.

## Streaming architecture

Real, provider-to-browser streaming — no `setTimeout`, no
character-by-character animation. The wire format is newline-delimited
JSON (NDJSON) over a plain `ReadableStream` response
(`Content-Type: application/x-ndjson`), which works with Vercel's
serverless functions and requires no WebSocket infrastructure:

```
{"type":"chunk","text":"Once "}
{"type":"chunk","text":"upon a time"}
{"type":"done","messageId":"..."}
```

or, on failure:

```
{"type":"chunk","text":"Once upon a "}
{"type":"error","message":"...","partial":true}
```

NDJSON (rather than bare text) lets the client distinguish a clean finish
from a dropped connection unambiguously — a stream that just stops
without a `done` or `error` line is treated as a failure by the client,
never as success. `components/chat/chat.tsx` reads the response body
with `res.body.getReader()`, buffers partial lines across chunk
boundaries, and applies each event as it arrives.

## Message persistence and failure handling

The assistant message is written to the database **once**, after the
stream finishes one way or another — never optimistically, and never
twice:

- **Clean finish:** insert with `status: "complete"`.
- **Provider/network error with some text already generated:** insert
  with `status: "incomplete"` and whatever text was produced. The UI
  (`MessageBubble`) renders this with a visible "This response was
  interrupted before it finished" notice — an incomplete generation is
  never presented as if it were a complete answer.
- **Provider/network error with zero text generated:** nothing is
  inserted; the client shows an inline retry banner instead.
- **Client disconnects mid-stream** (`request.signal` aborts): the route
  makes a best-effort attempt to persist whatever partial text exists as
  `incomplete`. This is genuinely best-effort — on some serverless
  runtimes the function can be torn down as soon as the client
  disconnects, before this code runs. See "Known limitations."

`messages.status` (migration `0003_message_status.sql`) is the field
that makes this possible; it defaults to `'complete'` so all Phase 1
rows and every user message (always written in full) are unaffected.

## Context-window strategy

Implemented in `lib/chat/context.ts` (`buildGeminiHistory`), documented
in code and covered by `lib/chat/context.test.ts`:

- At most `MAX_HISTORY_MESSAGES` (20) of the most recent messages are
  considered at all.
- Within that window, messages are kept from newest to oldest until
  `MAX_HISTORY_CHARACTERS` (8000) would be exceeded; older messages are
  dropped first.
- The single newest message is never dropped, even if it alone exceeds
  the character budget (it's already bounded to 4000 characters by
  `chatRequestSchema` at the point of entry).
- Assistant messages with `status: "incomplete"` (failed/cut-off
  attempts) are excluded from what's sent to Gemini — they're shown to
  the person as history, but aren't fed back into the model as if they
  were a real turn.

This is deliberately simple — no token counting, no summarization, no
RAG — trading precision for a cheap, predictable bound appropriate for a
free-tier deployment. A future phase could replace the character-based
heuristic with real token counting or a rolling summary without changing
the call site.

## System prompt

`lib/ai/system-prompt.ts` exports a single `SYSTEM_INSTRUCTION` string,
kept out of UI code entirely and passed to Gemini via
`config.systemInstruction`. It establishes concise, Markdown-formatted
answers and — importantly, since no browsing/files/tools exist yet —
explicitly instructs the model not to claim or imply it searched the web,
read a file, or used a tool it doesn't have.

## Retry

Retry is "regenerate a reply to an existing message," not "resend the
same text as a new message" — the latter would duplicate the user's
turn in the conversation, which the person would see as their own
question appearing twice. `lib/chat/ownership.ts`
(`validateRetryTarget`) enforces this: a retry is valid only when the
target is a `user`-role message in the right conversation, and every
message after it (if any) is an `assistant` message with
`status: "incomplete"`. Once a *complete* assistant reply exists after
the target, retrying that turn is rejected (`already_answered`) — the
conversation has moved on, and continuing should be done with a normal
new message instead.

On the client, two distinct failure shapes produce two different retry
behaviors (`components/chat/chat.tsx`):

- The server received and persisted the user's message before failing
  (response headers arrived) → retry sends `{ retryMessageId }`, so no
  new user row is created.
- The request never reached the server at all (e.g. the `fetch` itself
  failed) → nothing was persisted, so retry resends the original text as
  a new message — this is the one case where "resend as new" is correct,
  because there is no existing row to regenerate against.

Double-clicking retry, or clicking send while already streaming, is
blocked by disabling the composer while `isStreaming` is true.

## Authentication flow (unchanged, extended)

Every `/api/chat` request re-resolves the user from the Supabase session
cookie via `supabase.auth.getUser()` — exactly the pattern established
in Phase 1's Server Actions. There is no separate auth mechanism for the
streaming route, and RLS still applies to every query the route handler
makes (it uses the same request-scoped client as everything else — never
a service-role client).

## Security review (Phase 2 additions)

- The client can send a `conversationId`, but every use of it is
  re-verified against `auth.uid()` — first by an explicit ownership
  query in the route, and redundantly by RLS on every subsequent
  read/write. A conversation ID belonging to another user resolves as
  "not found," not "forbidden," so the response doesn't confirm whether
  the ID exists.
- `retryMessageId` goes through the same treatment plus
  `validateRetryTarget()` — a message ID from another conversation or
  another user fails ownership before it's ever considered.
- `GEMINI_API_KEY` is read only inside `lib/ai/gemini.ts`, on the server;
  it is never included in any response, log line surfaced to the client,
  or client bundle (no `NEXT_PUBLIC_` prefix).
- `mapUnknownError()` (`lib/chat/errors.ts`) is the single place
  provider/network/database errors are translated for the client —
  every code path in the route goes through it or `chatError()`
  directly, so raw provider payloads, stack traces, and database errors
  can't leak. Covered by `lib/chat/errors.test.ts`.
- No RLS policy was weakened. The only schema change (`0003`) adds a
  column with a safe default; it doesn't touch existing policies.

## Cost / free-tier considerations

- Message length is capped at 4000 characters (`MAX_MESSAGE_LENGTH`),
  bounding the size of any single request.
- Conversation history sent to Gemini is capped as described above
  (20 messages / 8000 characters), bounding cost per turn regardless of
  how long a conversation gets.
- No extra Gemini call is made to generate a conversation title —
  `deriveTitle()` is a pure string function.
- Duplicate-submit is prevented client-side (composer disabled while
  streaming) and structurally server-side (a retry never creates a
  second user message for the same turn).
- No Redis, queues, workers, or paid rate-limiting service — protections
  are the lightweight, in-request kind described above, appropriate for
  a solo-developer, free-tier deployment.

## Known limitations (Phase 2)

- **Client-disconnect persistence is best-effort.** If the browser tab
  closes or the network drops between the browser and *our* server
  mid-stream, the route's `request.signal` abort handler tries to
  persist the partial response, but on some serverless runtimes the
  function can be killed before that code runs. A failure between *our
  server* and *Gemini* is handled reliably (that's the common case and
  is fully tested via the error-mapping logic); a browser-side
  disconnect is the harder, less common case.
- **No true cancellation of the Gemini request itself.** Clicking "stop"
  aborts the client's read of the response and the server's forwarding
  loop checks `request.signal.aborted` between chunks, but there's no
  guarantee the in-flight call to Google's API is cancelled immediately
  server-side.
- **Live Gemini/Supabase behavior has not been exercised end-to-end in
  this environment** — this sandbox has no network access to
  `generativelanguage.googleapis.com` or a live Supabase project. What's
  verified here is: the code compiles and type-checks, all unit tests
  pass, `next build` succeeds, and the request/response contract (NDJSON
  framing, headers, error mapping) is implemented and unit-tested at the
  pure-logic layer. Manually testing an actual conversation against a
  real Supabase project and a real `GEMINI_API_KEY` is still required
  before shipping.
- No automated test hits the route handler itself (it needs a live or
  mocked Supabase + Gemini call to run meaningfully); tests cover the
  pure logic the route depends on (validation, context-window trimming,
  retry rules, error mapping, title derivation).

## Document upload (Phase 3)

**Supported formats:** PDF, DOCX, TXT, Markdown (`.md`) — nothing else.
**Size limit:** 5 MB, enforced both client-side (`lib/documents/limits.ts`,
for instant feedback) and server-side (`lib/documents/validate.ts`,
`validateUploadBasics` — the actual security boundary; the client check
is UX only).

**Upload flow** (`POST /api/documents`, `app/api/documents/route.ts`):

1. Authenticate the user.
2. `validateUploadBasics()` — extension, claimed MIME type, size — all
   before the file is even read into memory.
3. `verifyFileSignature()` — confirms the bytes actually match the
   claimed type: PDF magic bytes (`%PDF-`), ZIP magic bytes for DOCX
   (OOXML files are ZIP archives), and for TXT/MD (which have no magic
   number) a binary-content heuristic that rejects a renamed image or
   executable.
4. `extractDocumentText()` (`lib/documents/extract-text.ts`) — one entry
   point per format: [`unpdf`](https://github.com/unjs/unpdf) for PDF
   (chosen over the more commonly-tutorialed `pdf-parse`, which is
   effectively unmaintained; `unpdf` is an actively maintained pdf.js
   wrapper with zero required native dependencies, so it runs on
   Vercel's serverless functions without a native build step),
   [`mammoth`](https://github.com/mwilliamson/mammoth.js) for DOCX, and
   plain UTF-8 decoding for TXT/MD.
5. `normalizeExtractedText()` — collapses excess whitespace and blank
   lines, strips control characters, converts PDF page-break artifacts
   into paragraph breaks — without destroying real paragraph/list
   structure or lowercasing anything.
6. `hasMeaningfulText()` — rejects a document that produced no
   meaningful text (empty file, a scanned PDF with no text layer). The
   error message says plainly that OCR isn't supported rather than
   pretending the upload half-worked.
7. Only now is a `documents` row inserted — a document that fails
   extraction is never written to the database at all, so there's
   nothing to clean up on failure.
8. The original file is uploaded to private Supabase Storage
   best-effort (see "Storage decision" below) and `storage_path` is
   backfilled if that succeeds.

Every error in this path — corrupted file, password-protected PDF,
malformed DOCX — is mapped to a safe `DocumentExtractionError`
(`lib/documents/errors.ts`) before it can reach the client; parser
internals and stack traces never do.

## Storage decision

The app's actual dependency is `documents.extracted_text` — that's what
every document-grounded chat request reads. The original file is
preserved *in addition*, in a private Supabase Storage bucket
(`documents`, created by migration `0004_documents.sql`, `public: false`),
for future document management (re-processing, download), but uploading
it is deliberately **best-effort and non-fatal**
(`lib/documents/storage.ts`): if the storage call fails, the row is still
inserted with `storage_path: null` rather than failing the whole request
over a part of the system nothing yet depends on.

**Sequencing (fixed in the Phase 3 correction pass):** the document ID
is generated server-side (`randomUUID()`) *before* anything is written,
the Storage object is uploaded to a path built from that ID first, and
the `documents` row is inserted exactly once — already carrying the
correct `storage_path` (or `null`) from the start
(`lib/documents/upload-flow.ts`, `persistUploadedDocument`). The
original implementation instead inserted the row and then tried to
`UPDATE` it with the storage path — but `documents` deliberately has no
UPDATE RLS policy (see "Row Level Security" / migration `0004`), so that
backfill could silently fail, leaving a real Storage object with no
`storage_path` pointing to it (an orphan invisible to deletion). Insert-
once avoids the problem entirely rather than adding a broader UPDATE
policy just to allow it. If the Storage upload succeeds but the
database insert then fails, the uploaded object is deleted as cleanup
so it doesn't outlive the row that should own it.

Storage paths are always server-generated as
`${userId}/${documentId}/${sanitizedFilename}` — never built from a raw
client-controlled filename — which is both how path traversal is
prevented and how the bucket's RLS policies work: `(storage.foldername(name))[1]`
(the first path segment) is always the owning user's ID, so
`auth.uid()::text = (storage.foldername(name))[1]` gates select/insert/delete
per object, mirroring the same "derive ownership server-side" principle
used everywhere else in this codebase. No public URLs are ever generated.

## Document database model

- **`documents`** — one row per successfully-processed upload:
  `user_id`, `filename`, `mime_type`, `size_bytes`, `storage_path`
  (nullable), `extracted_text`, `extraction_status` (`'ready' | 'failed'`
  — Phase 3's synchronous flow only ever writes `'ready'`, since a
  failed extraction is rejected before any row is written; the column
  exists so a future async pipeline can use `'failed'` without a schema
  change). Indexed on `(user_id, created_at desc)`.
- **`conversation_documents`** — a join table, not a column on either
  side, because a document can be attached to more than one conversation
  (`conversation_id`, `document_id`, `user_id`, `created_at`; composite
  primary key). RLS's insert policy requires the caller to already own
  *both* the conversation and the document, which is what actually
  prevents attaching someone else's document even though the client only
  ever sends IDs. The association is written with `upsert(...,
  { onConflict: "conversation_id,document_id", ignoreDuplicates: true })`
  so re-attaching the same document to the same conversation is a no-op
  against the composite key rather than a duplicate row or a conflict
  error. A genuine failure writing this association is logged explicitly
  (`app/api/chat/route.ts`) rather than silently swallowed, but it does
  not fail the chat turn itself — the association is bookkeeping for
  future features (e.g. "documents used in this conversation"), not
  something the current answer depends on.
- **`messages.metadata`** (jsonb, added by the same migration) — records
  `{ documentId, filename }` on a user message that had a document
  attached. The document's extracted text is never duplicated into this
  column, or into any message — see "Document context in chat" below.

RLS on both new tables follows the exact pattern established in Phase 1:
select/insert/delete scoped to `auth.uid()`, denormalized `user_id`
columns so no policy needs a join, no service-role client anywhere.

## Document context in chat (Phase 3 — not RAG)

**This is explicitly not retrieval.** There is no embedding, no
chunking, no similarity search. A document is either fully (bounded) in
context or not attached at all.

When a message includes a `documentId` (`app/api/chat/route.ts`):

1. The document is fetched with an explicit ownership-scoped query
   before anything else happens — an unauthorized or nonexistent
   document ID fails before a user message is ever persisted.
2. The user message is persisted with **just the plain question text**
   in `content`, plus `{ documentId, filename }` in `metadata` — never
   the document's text. This is what "don't duplicate the full document
   text into every message" means in practice.
3. `buildDocumentContext()` (`lib/ai/document-prompt.ts`) applies a
   deterministic **beginning-of-document truncation**: the first
   `MAX_DOCUMENT_CONTEXT_CHARS` (12,000) characters, full stop. No
   relevance ranking, no "smart" section selection — Phase 3's
   documented limitation is that a question about the end of a long
   document may not have that part in context at all.
4. `buildDocumentGroundedMessage()` wraps that (possibly truncated) text
   in an explicit `<document filename="..." truncated="...">...</document>`
   block, followed by the question, and this — not the plain stored
   content — is what's sent to Gemini for *this turn only*.
5. `DOCUMENT_MODE_ADDENDUM` is appended to the system instruction only
   for this request, instructing the model to treat the delimited block
   as data to read and quote from, never as instructions to follow, and
   to say plainly when the document doesn't contain enough information
   rather than guessing — see "Prompt injection" below.
6. The reply streams exactly like normal chat (same NDJSON protocol,
   same persistence/incomplete handling, same retry rules) — document
   mode is an input transformation, not a different pipeline.

**Reopening a conversation** later shows the plain question with an
"Attached: filename" badge (from `metadata`) — it does not re-fetch or
re-display the document text inline, and continuing the conversation
without re-attaching the document does not resend its content on every
subsequent turn. Attaching a document is a per-turn choice, not a
sticky conversation mode.

**Retry** for a document-grounded turn re-fetches the document fresh
from `metadata.documentId` (`app/api/chat/route.ts`'s retry branch) —
if the document was deleted in the meantime, retry degrades gracefully
to a normal (non-document) regeneration rather than failing outright.

## Prompt injection

Uploaded document text is treated as **untrusted input**, consistent
with the same principle already applied to search results elsewhere in
this prompt: it is never interpolated into the system instruction (the
"trusted instructions" channel). It only ever appears inside the
delimited `<document>` block within a *user* turn, and
`DOCUMENT_MODE_ADDENDUM` explicitly tells the model that text inside
that block — including anything that reads like an instruction ("ignore
previous instructions...") — is data to describe, not a command to obey.
This is a prompting-level mitigation, not a guarantee; see "Known
limitations."

## Upload hardening

- 5 MB limit enforced server-side (see "Document upload" above) — the
  client-side check is UX only.
- Extension + MIME + magic-byte / binary-content checks, in that order,
  each cheaper than the next — a mismatched or forged type is rejected
  before the (more expensive) extraction step ever runs.
- Storage paths are always server-generated from `userId` + `documentId`,
  never from the raw filename, eliminating path traversal as a concern.
- No `dangerouslySetInnerHTML` anywhere in the document or chat rendering
  path (see "Chat architecture" above) — a malicious document can't
  execute script even if its content is later shown or quoted back by
  the model.
- Duplicate-submit protection is the same composer-disabled-while-busy
  pattern used for chat; there's no separate upload queue to abuse.

## Known limitations (Phase 3)

- **Beginning-of-document truncation, not relevance-based.** A question
  about page 40 of a 60-page PDF may get an answer based only on the
  first ~12,000 characters if the document exceeds that budget — this is
  the explicit, documented trade-off of not implementing retrieval yet
  (see "Future retrieval architecture" below).
- **No OCR.** A scanned PDF with no text layer is rejected with a clear
  message rather than silently producing an empty or garbage answer.
- **Prompt-injection mitigation is instructional, not structural.** Model
  behavior is guided by `DOCUMENT_MODE_ADDENDUM`, but an LLM can still in
  principle be influenced by adversarial document content — there's no
  hard sandboxing at the model level. Treat this as defense-in-depth
  alongside (not a replacement for) not granting the assistant any
  actions/tools that adversarial document text could misuse.
- **Original-file storage is best-effort.** A `documents` row with
  `storage_path: null` means the file itself wasn't preserved (extracted
  text always was) — this is intentional (see "Storage decision"), not a
  bug, but it does mean re-downloading the exact original isn't always
  possible.
- **No re-processing/versioning.** Documents are immutable once
  uploaded; there's no "re-extract" or "replace file" action — delete and
  re-upload.
- **Live extraction (real PDF/DOCX files, a live Supabase Storage
  bucket) has not been exercised end-to-end in this environment** — see
  the equivalent Phase 2 note; the same sandbox constraint (no network
  to live Supabase Storage) applies here. Unit tests cover the
  validation, normalization, context-truncation, and prompt-delimiting
  logic directly; manual testing with real files against a real
  Supabase project is still required before shipping.

## RAG architecture (Phase 4)

Phase 4 replaces Phase 3's `buildDocumentContext()` (fixed first-12,000-characters
truncation) with real retrieval-augmented generation: chunking, Gemini
embeddings, `pgvector` similarity search, and citations built entirely
from what the server actually retrieved. The flow described in "Document
context in chat (Phase 3 — not RAG)" above is retired for document Q&A;
that section and `lib/ai/document-prompt.ts` are kept in the codebase for
reference and because their tests still document the old behavior, but
`app/api/chat/route.ts` no longer calls them.

Uploaded document → extracted text (Phase 3, unchanged) → chunking
(`lib/rag/chunk.ts`) → embeddings (`lib/rag/embedding-provider.ts`) →
stored in `document_chunks` (Supabase Postgres + pgvector) →
question → query embedding → `match_document_chunks` similarity search
(`lib/rag/retrieval.ts`) → top relevant chunks → Gemini prompt built with
retrieved context (`lib/ai/rag-prompt.ts`) → streamed answer → source
metadata returned to the UI (`components/chat/message-bubble.tsx`).

### Embedding provider (Phase 4)

`lib/rag/embedding-provider.ts` wraps the Google GenAI SDK's
`models.embedContent` behind a small `EmbeddingProvider` interface
(`embedText`, `embedTexts`), the same seam-first approach as
`lib/ai/provider.ts` for the chat model. The model name
(`GEMINI_EMBEDDING_MODEL`, default `gemini-embedding-001`) and output
width (`GEMINI_EMBEDDING_DIMENSIONS`, default `768`) are both
env-configurable and never hardcoded elsewhere.

Two Gemini embedding models currently exist: `gemini-embedding-001`
(stable, text-only) and `gemini-embedding-2` (newer, multimodal).
`gemini-embedding-001` is used by default because it natively returns one
embedding per input string when `contents` is an array — exactly this
app's "batch of independent chunks → one vector each" shape — and
natively supports `task_type: RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`,
matching the asymmetric way documents vs. queries are embedded here.
`gemini-embedding-2` aggregates multiple plain-text inputs into a single
embedding unless each is wrapped in its own `Content` object, which is a
worse fit for this batching pattern.

Both models are trained with Matryoshka Representation Learning and
support truncating their native 3072-dimension output via
`output_dimensionality`; Google's documentation recommends 768, 1536, or
3072. **768** is used here — the smallest recommended size — to keep
`document_chunks`' vector column and its HNSW index small on a free-tier
Postgres instance. `gemini-embedding-001`'s non-3072-dimension output is
not pre-normalized by the API (unlike `gemini-embedding-2`'s), so the
provider L2-normalizes it manually per Google's documented guidance.

Batching (`embedTexts`) sends `RAG_EMBEDDING_BATCH_SIZE` (default 16)
inputs per `embedContent` call, looping over batches sequentially — small
enough to stay well under `gemini-embedding-001`'s ~2,048-token/input
limit at the chosen chunk size, and to keep any single request cheaply
retryable. Malformed or wrong-dimension responses are rejected
(`validateEmbedding`) before ever reaching storage.

### Chunking strategy (Phase 4)

`lib/rag/chunk.ts` is a deterministic, dependency-free, character-based
chunker — there is no token counting; character count is a documented
approximation, conservative enough to stay under the embedding model's
token limit at the chosen size. The same document always produces the
same chunks (no randomness, no timestamps).

- Paragraphs (blank-line-separated) are packed greedily into a chunk up
  to **`RAG_CHUNK_MAX_CHARS`** (default **1800**) characters.
- A single paragraph longer than that is split at sentence boundaries,
  falling back to word boundaries — a chunk boundary never lands
  mid-word.
- Each chunk after the first is seeded with up to
  **`RAG_CHUNK_OVERLAP_CHARS`** (default **200**) characters of trailing
  context from the previous chunk (word-boundary-safe), so a fact split
  across a flush point stays findable from either side.
- A trailing chunk shorter than **`RAG_CHUNK_MIN_CHARS`** (default
  **200**) is merged into its predecessor rather than stored (and
  embedded) on its own.

### Vector dimension and pgvector configuration (Phase 4)

`supabase/migrations/0005_rag.sql` declares `document_chunks.embedding`
as `vector(768)`, matching `EMBEDDING_DIMENSIONS` in `lib/rag/config.ts`.
This is not an assumed default — it is the deliberately chosen
Matryoshka truncation size described above. If the embedding model or
dimension is ever changed, both the env var and this column's declared
width must change together in a new migration; pgvector enforces the
declared width at insert time, so a mismatch fails loudly rather than
silently corrupting similarity search.

**Similarity metric**: cosine, via pgvector's `<=>` operator
(`vector_cosine_ops`), matching Google's documented recommendation for
Gemini embeddings. `match_document_chunks` converts pgvector's cosine
*distance* (`0` = identical) into a similarity score in `[-1, 1]`
(`1` = identical, via `1 - distance`) so the app can apply
`RAG_SIMILARITY_THRESHOLD` as a plain "higher is better" cutoff.

**Vector index**: HNSW, not IVFFlat. IVFFlat's `lists` parameter needs to
be sized against the eventual row count and re-tuned as data grows, which
doesn't fit a small, continuously-growing free-tier dataset with no
maintenance job to rebuild it. HNSW builds incrementally with reasonable
defaults and no row-count tuning, at the cost of somewhat slower inserts
— an acceptable trade at this app's scale.

### Document chunks table and security (Phase 4)

`document_chunks` (id, document_id, user_id, chunk_index, content,
embedding, metadata, created_at) denormalizes `user_id` from the parent
`documents` row — the same pattern already used by `conversation_documents`
— so RLS and `match_document_chunks` never need a join to enforce
ownership. RLS is enabled with select/insert/delete-own policies; there
is no update policy, because a chunk is never edited in place —
reprocessing deletes and re-inserts (`lib/rag/pipeline.ts`).

`match_document_chunks` (the only path to chunk similarity search) is
`SECURITY INVOKER` (the default), so it runs under the caller's own RLS.
It also adds an explicit `dc.user_id = auth.uid()` predicate in its
`WHERE` clause as defense in depth — ownership is enforced by the
function itself, not only by RLS being present, and not only by the API
route trusting the document IDs it was given.  `lib/rag/retrieval.ts`
adds a second, application-level check: any chunk the RPC returns for a
document ID outside the caller-supplied `documents` list is dropped
before ever reaching the prompt, even though this should never happen in
normal operation given the RPC's own scoping.

`metadata` on each chunk holds only small, structured citation extras
(`filename`, `contentType`) derived from the parent document row at
embedding time — never invented, never containing the chunk's own text
twice.

### Retrieval scope (Phase 4)

Retrieval is scoped to **the conversation's** attached, `ready` documents
— every document ever associated with the conversation via
`conversation_documents` (`lib/rag/retrieval.ts`'s
`getRetrievableDocuments`), not just whatever was (re-)attached on the
current turn. This is an intentional behavior change from Phase 3, where
grounding was strictly per-turn (a document had to be re-attached every
message to be used again). It's safe now because retrieval only ever
embeds the *query* — never the document — so there's no meaningful extra
cost to keeping earlier-attached documents "in scope" for later turns in
the same conversation. It still keeps a conversation's documents from
leaking into an unrelated conversation: `getRetrievableDocuments` only
ever looks at rows in `conversation_documents` for the one
`conversation_id` in question, never "everything the user owns" (Phase 4
brief, "Retrieval + normal chat" / "Conversation + multiple documents").

A document attached to the *current* turn but not yet `ready` (still
`processing`, or `failed`) is rejected up front with a clear message
(`app/api/chat/route.ts`) rather than silently falling back to
ungrounded chat or to Phase 3's truncation — the person is told to wait
or to reprocess the document.

Retrieval never runs at all (`ragAttempted = false`) when a conversation
has no ready documents attached — this is what keeps plain chat
byte-for-byte unaffected: no query embedding call, no
`match_document_chunks` call, no addendum appended to the system
instruction.

### Top-K, similarity threshold, and context budget (Phase 4)

- **`RAG_TOP_K`** (default **6**): how many nearest chunks
  `match_document_chunks` returns per query. Kept conservative — free-tier
  Gemini/Postgres usage doesn't need (or benefit from) dozens of
  marginally-relevant chunks per question.
- **`RAG_SIMILARITY_THRESHOLD`** (default **0.5**, cosine similarity in
  `[-1, 1]`): chunks scoring below this are dropped before ever reaching
  the prompt. If nothing clears the bar, the model is told plainly (via
  `RAG_MODE_ADDENDUM` + the "no relevant passages were found" context
  block) rather than guessing from unrelated chunks or general knowledge.
- **`RAG_MAX_CONTEXT_CHARS`** (default **6000**) / **`RAG_MAX_CHARS_PER_CHUNK`**
  (default equal to `RAG_CHUNK_MAX_CHARS`, 1800): a hard ceiling on total
  retrieved-chunk characters placed in a single prompt, independent of
  top-K — a safety net if top-K chunks happen to be unusually large. At
  least one chunk is always included even if it alone exceeds the budget
  (better to answer from one oversized-but-relevant passage than none),
  after which additional chunks are dropped rather than let the budget
  run meaningfully negative.

### Source citation architecture (Phase 4)

Citations are **always server-derived, never model-parsed**. The server
already knows exactly which chunks it retrieved and placed in the
prompt's `<retrieved_context>` block (`lib/ai/rag-prompt.ts`); the "Sources"
list shown under an assistant reply
(`components/chat/message-bubble.tsx`) is always exactly that same set —
the chunks actually used for that turn — carried through the streamed
`done` event and persisted into the assistant message's `metadata.sources`
column. The model is explicitly told (`RAG_MODE_ADDENDUM`) that it does
not need to produce citation markers, page numbers, or source labels
itself, and nothing in the pipeline ever parses the model's reply text
looking for them. There is deliberately nothing to "validate or
normalize" from model output, because nothing from model output ever
becomes a citation — which is the strongest form of "do not trust
model-generated citations" available: there's no trust decision to make.

Each `SourceRef` carries `documentId`, `filename`, `chunkId`,
`chunkIndex`, `similarity`, and the retrieved `content` itself (already
bounded by `RAG_MAX_CHARS_PER_CHUNK` — never more than what was already
placed in the model's prompt), which is what powers the expandable
"Source preview" in the UI without a second round trip. No page numbers
are shown or invented: this codebase's PDF extraction (Phase 3,
`lib/documents/extract-text.ts`) does not currently track per-page text
boundaries, so citations reference `filename` + `chunk index` only,
per the brief's "do not invent page numbers" requirement. If page-aware
extraction is added later, `chunk_index`'s neighbor in `metadata` is
where a real page number would go.

### Prompt injection defense (Phase 4)

Unchanged in spirit from Phase 3's `DOCUMENT_MODE_ADDENDUM`: retrieved
text is wrapped in an explicit `<retrieved_context>` block, itself made
of individually-delimited `<source id="..." filename="..." chunk="...">`
tags with the filename attribute-escaped, followed by the actual
question outside the block. `RAG_MODE_ADDENDUM` explicitly instructs the
model to treat everything inside `<retrieved_context>` as data to
describe, never as instructions to follow — including text that looks
like a command. See `lib/ai/rag-prompt.test.ts` for the injection-shaped
test cases (an attempted fake closing tag, embedded "ignore previous
instructions"-style text).

### Document processing status (Phase 4)

`documents.extraction_status` gained a third value: `'processing'`
(alongside Phase 3's `'ready'` / `'failed'`). There is no separate
`'uploaded'` state — text extraction and embedding both happen
synchronously within the same upload request (no background workers; see
"Deployment strategy" below), so there's no user-visible gap for a fourth
state to occupy. A document is only ever `'ready'` once its chunks are
actually stored (`lib/rag/pipeline.ts`); a document attached to a chat
turn that isn't `'ready'` is rejected with a clear message rather than
used.

Migration 0005 backfills existing Phase 3 rows: any document with
`extraction_status = 'ready'` and `chunk_count = 0` (i.e., every document
that existed before chunking did) is moved to `'processing'`, so it shows
up through the same "not ready yet" UI path and becomes eligible for the
reprocess endpoint, instead of silently claiming to be retrievable while
having no chunks.

### Failure, cleanup, and retry (Phase 4)

`lib/rag/pipeline.ts`'s `processDocumentEmbeddings` is the single place
all of this is handled, and it never throws — callers get back
`{ ok, chunkCount, error? }` rather than needing a try/catch:

1. Existing chunks for the document are deleted first (idempotent —
   makes retrying a previous failed *or successful* run safe, never
   duplicating rows against the `unique(document_id, chunk_index)`
   constraint).
2. Text is chunked; zero chunks (e.g. empty/whitespace-only extracted
   text) fails immediately.
3. Chunks are embedded; a provider error (rate limit, bad API key,
   network failure, malformed response) is mapped to a safe message
   (`lib/rag/errors.ts`) and fails the document.
4. Chunks are inserted; an insert failure triggers an immediate cleanup
   delete (never leaving a partially-inserted batch behind) and fails the
   document.
5. Only once chunks are durably stored is `documents.extraction_status`
   flipped to `'ready'`. If *that* update itself fails, the chunks are
   valid but the pipeline still reports failure — a document stuck
   showing `'processing'` forever with unrecognized chunks nobody knows
   to use is exactly the "misleading partial state" this is meant to
   avoid.

Every failure path converges on the same `failDocument` helper:
`extraction_status = 'failed'`, `chunk_count = 0`, and a safe
`processing_error` message — never a partial mix of "some chunks, status
says failed" or "status says ready, zero chunks". `POST
/api/documents/[id]/reprocess` calls the exact same pipeline against the
document's already-stored `extracted_text` (no re-extraction from the
original file needed), so retrying is a clean, ownership-checked re-run;
the Files page offers this as a "Retry processing" action for any
document showing `'failed'`.

### Testing (Phase 4)

New unit tests, mocking the embedding provider / Supabase boundary
rather than requiring live Gemini or Supabase credentials:

- `lib/rag/chunk.test.ts` — determinism, overlap, paragraph/word-boundary
  behavior, empty input.
- `lib/rag/embedding-provider.test.ts` — dimension/malformed-response
  validation, batching, normalization, missing-API-key and rate-limit
  error mapping.
- `lib/rag/pipeline.test.ts` — the full chunk→embed→store→ready flow and
  every failure/cleanup branch (delete failure, embed failure, insert
  failure, status-update failure, mismatched embedding count).
- `lib/rag/retrieval.test.ts` — conversation scope resolution
  (attached-and-ready only), similarity threshold filtering, context
  budget enforcement, and the defense-in-depth drop of any chunk outside
  the requested document set.
- `lib/ai/rag-prompt.test.ts` — grounded message construction, multi-source
  labeling, attribute escaping, and injection-shaped content.

### Known limitations (Phase 4)

- **No background workers**: embedding happens synchronously in the
  upload/reprocess request. A very large document could make an upload
  request slow; there's no progress indicator beyond the "Processing…"
  status shown on the Files page.
- **No page-aware citations**: `lib/documents/extract-text.ts` doesn't
  currently track per-page boundaries for PDFs, so citations are
  filename + chunk-index only, per the "don't invent page numbers"
  requirement above.
- **Character-based chunking**: an approximation of token count, not an
  exact one (see "Chunking strategy" above); chosen for zero extra
  dependencies and determinism.
- **Retrieval scope is conversation-wide, not per-turn**: see "Retrieval
  scope" above — a deliberate choice, but one worth knowing about if a
  future UI wants a way to temporarily "mute" a document within an
  otherwise document-grounded conversation.
- **A transient embedding-provider failure during retrieval degrades a
  single turn to ungrounded-looking-empty context** (the model is told no
  relevant passages were found) rather than failing the whole chat
  request — prioritizing normal chat availability over a hard failure,
  at the cost of a possibly confusing "I don't have enough information"
  reply on a turn where the real cause was an outage, not missing data.

## Conversation UX (Phase 5)

### Regenerate
`POST /api/chat` with `{ conversationId, regenerateMessageId }`. Only the **latest** message may be regenerated, and it must be an assistant message answering a user message (`validateRegenerateTarget`, `lib/chat/ownership.ts`). Replacing a reply in the middle would strand later turns that answered text that no longer exists; use edit for earlier history.

Persistence order is *generate → insert new reply → delete old reply*. If generation fails, is cancelled, or the old row can't be retired, the original reply is untouched (a failed swap deletes the new row again). Nothing is persisted for a failed/cancelled regeneration — no "interrupted" row. The replaced reply is excluded from the model's context. RAG retrieval is unchanged: it is scoped to the conversation's documents, and `sources` are still derived from the retrieved chunks, never from model text.

### Edit + resend
`POST /api/chat` with `{ conversationId, editMessageId, content }`. Strategy: **truncate from the edited message onward and answer the edited text** — no branching, no versioning table.

`messages` deliberately has no UPDATE policy and Phase 5 adds none. So: (1) INSERT the replacement user message, (2) DELETE the original and everything after it in one atomic statement (replacement excluded by id), (3) delete the replacement again if step 2 fails. The conversation can never end up with both the edit and the stale tail, or with neither. The document attachment metadata is carried onto the replacement, and `conversation_documents` links that only removed messages justified are removed (`findStaleDocumentIds`), so a document attached in a discarded branch stops grounding answers. The conversation title is not re-derived. Only the caller's own *user* messages are editable.

Two DB statements are not one transaction; the rollback above covers the failure modes. A crash between step 1 and step 2 would leave the edited message duplicated at the end of the conversation (visible, not corrupt).

### Retry cleanup
Retrying now deletes stale *incomplete* assistant attempts server-side (previously only the client hid them, so they reappeared after a refresh).

### Conversation management
`PATCH /api/conversations/[id]` (rename) and `DELETE /api/conversations/[id]`. Titles are whitespace-collapsed, 1–80 chars. Both filter by id **and** session user id, and RLS enforces the same; RLS reports another user's row as "0 rows affected", which is treated as 404 (identical to a missing id). Delete cascades to `messages` and `conversation_documents` via existing foreign keys; `documents` and their chunks are never touched. Renaming bumps `updated_at` (existing trigger), so a renamed conversation sorts to the top.

### Search
`GET /api/conversations/search?q=` → `search_conversations` RPC (migration 0007): `SECURITY INVOKER`, hard-scoped to `auth.uid()` (same pattern as `match_document_chunks`). Titles match by case-insensitive substring (LIKE wildcards escaped). Message text matches by PostgreSQL full-text search with the `simple` config, all words required, each as a **prefix** (`regen` finds `regenerate`) — it is word-prefix search, not arbitrary substring. Input is split into alphanumeric tokens so it cannot inject tsquery syntax. Bounded: min 2 / max 100 chars, the 200 most recent matching messages are considered, at most 20 results. The client debounces (300 ms), aborts superseded requests, and ignores stale responses.

### Streaming robustness
The NDJSON reader (`lib/chat/stream.ts`) skips malformed events instead of failing, treats a stream that ends without a `done`/`error` event as *interrupted* (never complete), keeps text already received when the connection drops, and is aborted on unmount. A 60 s no-data watchdog aborts stalled requests so the UI cannot stay in "Generating…". A saved user message with no reply (e.g. tab closed mid-generation) shows a Retry banner on load.

### Errors
Error responses carry `{ error, code }`. `lib/chat/error-state.ts` maps them to: auth, network (browser-side), provider, rate-limit, document (not ready/failed), retrieval (non-fatal notice on a reply), validation, not-found, unknown. Client-thrown text ("Failed to fetch", JSON parse errors) is never displayed. Retrieval failure no longer degrades silently: the reply is marked with a notice.

### Security decisions
No client-supplied user id is trusted anywhere; no service role; no RLS policy added or changed. Every new write is filtered by conversation/message id and session user and validated in pure, tested functions. Cross-user attempts were verified against real PostgreSQL (`supabase/tests/0007_conversation_search.test.sql`) and in route tests.

### Known limitations (Phase 5)
- Only the latest reply can be regenerated; earlier history changes via edit (which discards later messages — there is no undo).
- Rename/delete live on the Conversations page, not in the sidebar's Recent list.
- Message search is word-prefix based; the Conversations page lists the 50 most recent (older ones via search). The chat loads the latest 200 messages.
- Edit/regenerate multi-step writes are not a single DB transaction (see above).
- Refresh-during-generation persistence remains best-effort on serverless runtimes (unchanged from Phase 2).

## Environment variable strategy

Two tiers, enforced by Next.js's `NEXT_PUBLIC_` convention:

- **Public**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` —
  safe in the browser; the anon key has no privileges beyond what RLS
  grants.
- **Server-only**: `GEMINI_API_KEY`, `GEMINI_MODEL`,
  `GEMINI_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_DIMENSIONS`, and the
  `RAG_*` tunables described above — never given the `NEXT_PUBLIC_`
  prefix, so they can never be bundled client-side. All `RAG_*` and
  `GEMINI_EMBEDDING_*` variables are optional with the free-tier-oriented
  defaults documented in "RAG configuration defaults (Phase 4)" above.

The app is written to build successfully even when these are unset (see
"Deployment" below), so CI/build environments without secrets don't fail
for the wrong reason.

## RAG configuration defaults (Phase 4)

Referenced throughout the section above; collected here for quick
reference (all in `lib/rag/config.ts`, all env-overridable):

| Variable | Default | Why |
| --- | --- | --- |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | Native per-string batching + `task_type` support; see "Embedding provider" above. |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Smallest of Google's recommended Matryoshka truncation sizes (768/1536/3072); keeps pgvector small on free tier. |
| `RAG_CHUNK_MAX_CHARS` | `1800` | Comfortably under `gemini-embedding-001`'s ~2,048-token input limit at a ~4-char/token approximation. |
| `RAG_CHUNK_OVERLAP_CHARS` | `200` | Enough trailing context to keep a fact split across a chunk boundary findable from either side, without duplicating much text. |
| `RAG_CHUNK_MIN_CHARS` | `200` | Below this, a trailing chunk is merged into its predecessor rather than embedded on its own. |
| `RAG_EMBEDDING_BATCH_SIZE` | `16` | Keeps a single embedding request small and cheaply retryable. |
| `RAG_TOP_K` | `6` | Conservative default; free-tier usage doesn't benefit from dozens of marginal matches per question. |
| `RAG_SIMILARITY_THRESHOLD` | `0.5` | Cosine similarity in `[-1, 1]`; chunks below this never reach the prompt. |
| `RAG_MAX_CONTEXT_CHARS` | `6000` | Hard ceiling on total retrieved-chunk characters per prompt, independent of top-K. |
| `RAG_MAX_CHARS_PER_CHUNK` | `1800` (= `RAG_CHUNK_MAX_CHARS`) | Per-chunk cap when building the prompt; defense in depth alongside the write-time chunk size cap. |

## Deployment strategy

Target: Vercel free tier + Supabase free tier.

- Next.js App Router with Server Actions deploys natively to Vercel with
  no custom server.
- No Redis, no queues, no background workers, no Docker — everything runs
  in request/response or Server Action calls, which fits Vercel's
  serverless model and Supabase's free tier. This includes RAG embedding
  (Phase 4): chunking and embedding run synchronously inside the upload
  and reprocess request handlers, not in a worker.
- Supabase migrations are plain SQL files under `supabase/migrations/`,
  run via the Supabase CLI (`supabase db push`) or pasted into the SQL
  editor — no separate migration runner dependency. `pgvector` is enabled
  via `0005_rag.sql`'s `create extension if not exists "vector"` — no
  separate vector database service.
