# Nexora

An AI knowledge workspace — chat with an AI that can actually read your documents and answer questions grounded in them, not just guess.

I built this as a full-stack project to learn how a real production app comes together: auth, a Postgres database with row-level security, streaming AI responses, and retrieval-augmented generation (RAG) for document Q&A — all wired up end to end.

## What it does

- **Chat** — real-time streaming responses from Google's Gemini models, with markdown rendering, retry, edit-and-resend, and regenerate.
- **Document upload** — drop in a PDF, DOCX, or text file, and it gets processed and embedded automatically.
- **Grounded answers** — attach a document to a conversation and ask questions about it. Answers come with real source citations (filename + the actual passage used), not made-up references.
- **Conversation history** — search, rename, and delete past conversations.
- **Auth** — sign up, log in, and your data stays yours (row-level security in the database, not just app-level checks).
- **Light/dark/system theme**, fully responsive, accessible.

## Tech stack

- **Next.js 14** (App Router) + TypeScript
- **Tailwind CSS** for styling
- **Supabase** — Postgres database, auth, file storage, and `pgvector` for embeddings
- **Google Gemini** — for chat responses and generating embeddings
- **Zod** for validation, **Vitest** for tests
- Deploys clean to Vercel's free tier + Supabase's free tier — no Redis, no background workers, no separate vector DB

## Running it locally

```bash
npm install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and GEMINI_API_KEY
npm run dev
```

The app will start even without those filled in, but chat and auth won't actually work until you add them.

### Getting the keys

1. **Supabase** — create a free project at [supabase.com](https://supabase.com), then grab your Project URL and anon key from Settings → API.
2. **Gemini API key** — get a free one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### Setting up the database

Run the SQL files in `supabase/migrations/` **in order** (0001 through 0009) using the Supabase SQL editor, or with the CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Each migration builds on the last — schema, auth triggers, row-level security, the documents/RAG tables with `pgvector`, conversation search, and rate limiting. Don't skip `0009` — it hardens the rate-limiting function and is required, not optional.

## Environment variables

See `.env.example` for the full list with comments. The three that actually matter to get started:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (safe to expose — protected by row-level security) |
| `GEMINI_API_KEY` | Needed for chat and embeddings to actually work |

Everything else (model name, chunking settings, rate limits) has sensible defaults and is optional.

## Useful commands

```bash
npm run dev      # start the dev server
npm test         # run the test suite
npm run lint     # lint the code
npm run build    # production build
```

## How it's put together

If you want the deeper technical details — database schema, RLS policies, the RAG pipeline (chunking → embedding → retrieval), streaming protocol, prompt-injection handling — see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Deploying

1. Set up your Supabase project and run the migrations (see above).
2. Push this repo to GitHub.
3. Import it into [Vercel](https://vercel.com), add the environment variables (same ones as `.env.local`), and deploy.
4. In Supabase, add your live Vercel URL under Authentication → URL Configuration so login/signup work in production.

That's it — Vercel handles the build automatically.

## What's not in here (yet)

- OCR for scanned documents
- Page-number-aware citations (just filename + chunk right now)
- Reranking / hybrid keyword+vector search
- Voice, image generation, multi-agent workflows, billing

## Known rough edges

- Document embedding happens synchronously during upload — a very large file can make that request take a while, with just a "Processing…" indicator (no progress bar).
- Chunking is character-based rather than exact-token-based — close enough in practice, not perfectly precise.
- The rate limiter uses a simple fixed-window approach, which can technically allow a small burst over the limit right at a window boundary — an accepted trade-off for keeping things simple and free of extra infrastructure.