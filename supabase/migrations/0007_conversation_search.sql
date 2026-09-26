-- 0007_conversation_search.sql
-- Phase 5: conversation search (title + message text) using only built-in
-- PostgreSQL features — no external search service.
--
-- This migration adds NO table, NO column, and NO policy. Existing RLS is
-- untouched: messages remain append-only from the client's perspective
-- (insert/delete own, no update), which is exactly what Phase 5's
-- edit-and-resend and regenerate flows rely on (they insert a replacement
-- row and delete the superseded rows; they never UPDATE a message).

-- ---------------------------------------------------------------------------
-- Full-text index over message text.
--
-- 'simple' config on purpose: no stemming and no stop-word removal, so
-- searching for a word finds that word in any language, and a typed prefix
-- ("regen") matches "regenerate" via the :* prefix operator built below.
-- The index expression must match the query expression exactly
-- (to_tsvector('simple', content)) for the planner to use it.
-- ---------------------------------------------------------------------------
create index if not exists messages_content_fts_idx
  on public.messages
  using gin (to_tsvector('simple', content));

-- ---------------------------------------------------------------------------
-- search_conversations
--
-- SECURITY INVOKER (the default), same pattern as match_document_chunks
-- (0005): it runs with the caller's own privileges, so the conversations /
-- messages RLS policies apply exactly as they would to any other query.
-- The explicit `user_id = auth.uid()` predicates are deliberate
-- belt-and-braces — ownership is enforced by the function itself, not just
-- by RLS being present.
--
--  * Title match: case-insensitive substring (ilike), with LIKE wildcards
--    in the user's input escaped so "50%" or "a_b" search literally.
--  * Message match: every word in the query must appear (AND), the last
--    and earlier words as prefixes. Only the most recent 200 matching
--    messages are considered, which bounds the cost of a very common word.
--  * One row per conversation, most recently updated first, hard-capped.
--  * A message hit returns a short excerpt with matched terms wrapped in
--    U+27E6 / U+27E7 markers; the client turns these into <mark> React
--    nodes (never innerHTML).
-- ---------------------------------------------------------------------------
create or replace function public.search_conversations(
  search_query text,
  result_limit integer default 20
)
returns table (
  id uuid,
  title text,
  updated_at timestamptz,
  match_type text,
  snippet text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q text := btrim(coalesce(search_query, ''));
  like_pattern text;
  ts_query tsquery;
  prefix_terms text;
  lim integer := least(greatest(coalesce(result_limit, 20), 1), 50);
begin
  -- No session, or a query too short to be meaningful: return nothing
  -- rather than scanning everything the caller owns.
  if auth.uid() is null or char_length(q) < 2 then
    return;
  end if;

  like_pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  -- Build "term1:* & term2:*" from alphanumeric runs only. Splitting on
  -- everything else means user input can never inject tsquery operators
  -- (& | ! ( ) : * <->), so to_tsquery below cannot raise a syntax error.
  select string_agg(term || ':*', ' & ')
    into prefix_terms
    from regexp_split_to_table(lower(q), '[^[:alnum:]]+') as term
   where term <> '';

  if prefix_terms is not null then
    ts_query := to_tsquery('simple', prefix_terms);
  end if;

  return query
  with title_hits as (
    select c.id
      from public.conversations c
     where c.user_id = auth.uid()
       and c.title ilike like_pattern escape '\'
  ),
  recent_message_hits as (
    select m.conversation_id, m.content, m.created_at
      from public.messages m
     where ts_query is not null
       and m.user_id = auth.uid()
       and m.role in ('user', 'assistant')
       and to_tsvector('simple', m.content) @@ ts_query
     order by m.created_at desc
     limit 200
  ),
  message_hits as (
    select distinct on (r.conversation_id)
           r.conversation_id, r.content
      from recent_message_hits r
     order by r.conversation_id, r.created_at desc
  )
  select
    c.id,
    c.title,
    c.updated_at,
    case when th.id is not null then 'title' else 'message' end as match_type,
    case
      when th.id is null and mh.conversation_id is not null then
        ts_headline(
          'simple', mh.content, ts_query,
          'StartSel="⟦", StopSel="⟧", MaxWords=24, MinWords=8, MaxFragments=1'
        )
      else null
    end as snippet
    from public.conversations c
    left join title_hits th on th.id = c.id
    left join message_hits mh on mh.conversation_id = c.id
   where c.user_id = auth.uid()
     and (th.id is not null or mh.conversation_id is not null)
   order by c.updated_at desc
   limit lim;
end;
$$;

comment on function public.search_conversations is
  'Phase 5: title (ilike) + message (full-text, prefix) search over the caller''s own conversations. SECURITY INVOKER and hard-scoped to auth.uid(); returns at most 50 rows, one per conversation.';

grant execute on function public.search_conversations(text, integer) to authenticated;
