-- 0003_message_status.sql
-- Phase 2 needs to distinguish a fully-generated assistant reply from one
-- that was cut off mid-stream (provider error, network failure, etc.), so
-- the UI can show "This response was interrupted" instead of silently
-- presenting a partial answer as complete.

alter table public.messages
  add column if not exists status text not null default 'complete'
    check (status in ('complete', 'incomplete'));

comment on column public.messages.status is
  'complete: the message finished generating normally. incomplete: generation was interrupted (provider/network error) and this is a partial response.';

-- User messages are always 'complete' by construction (they're written in
-- full before the request is ever sent), so no backfill is needed for
-- existing rows — the column default already covers them correctly.
