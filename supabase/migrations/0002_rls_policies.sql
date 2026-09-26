-- 0002_rls_policies.sql
-- Every policy below is scoped with auth.uid(), so access is enforced by
-- Postgres itself regardless of what the client sends. There is no
-- service-role bypass anywhere in this app.

-- ---------------------------------------------------------------------------
-- profiles: a user may only see and edit their own profile row.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert/delete policy: profile rows are created only by the
-- `handle_new_user` trigger (security definer) and cascade-deleted with the
-- auth user, so no policy is needed for either from the client.

-- ---------------------------------------------------------------------------
-- conversations: a user may only see, create, update, and delete their own.
-- ---------------------------------------------------------------------------
drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own"
  on public.conversations for select
  using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own"
  on public.conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
  on public.conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own"
  on public.conversations for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- messages: scoped by the denormalized user_id column (see 0001). A user
-- can only write a message whose user_id matches them AND whose parent
-- conversation is also theirs, so a message can never be attached to
-- someone else's conversation.
-- ---------------------------------------------------------------------------
drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own"
  on public.messages for select
  using (auth.uid() = user_id);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
  on public.messages for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own"
  on public.messages for delete
  using (auth.uid() = user_id);

-- Messages are treated as append-only from the client; no update policy is
-- defined. A future "edit message" feature should add one explicitly rather
-- than inherit broad update rights.
