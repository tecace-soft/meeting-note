-- Close a CONFIRMED live data exposure: public.chat and public.session had RLS
-- disabled and were readable with the public anon key shipped in the web bundle.
-- Verified 2026-10-05 via an unauthenticated anon request: chat returned 43 rows,
-- session 17 rows, while public.note (RLS on) returned none.
--
-- Root cause: both tables were created directly in the hosted project (not via a
-- repo migration), so RLS was never enabled and the default public-schema grants
-- to anon/authenticated still applied, leaving every row globally readable.
--
-- This is SEPARATE from PR #24 (that PR does not touch these tables); it is a
-- pre-existing exposure.
--
-- Access model = PROJECT-SCOPED, chosen to close the leak WITHOUT changing current
-- app behavior. Today the web client reads session by project_id and chat by
-- session_id with no user filter, so anyone who can open a project already sees all
-- of that project's chat; project sharing (project.shared_users) lets collaborators
-- open shared projects. These policies enforce exactly that at the database: a row
-- is visible iff the caller can access its project (owner or shared collaborator),
-- mirroring the project_owner_select / note_owner_select pattern
-- (20260602124000, 20260630123000). INSERT authorship is pinned to the caller so a
-- user cannot forge another user's chat; chat edits/deletes stay author-only.
--
-- Columns relied on (verified against src/pages/Project.tsx):
--   session(id, created_at, project_id)                              -- no user_id
--   chat(id, message, user_id, session_id, project_id, response, created_at)
--
-- After applying, re-run the content-free anon probe: both tables should return 0
-- rows to the anon key (like public.note), while the authenticated web app still
-- loads each caller's accessible sessions and chat.

-- ============================ session ============================
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.session FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session TO authenticated;

DROP POLICY IF EXISTS session_project_access_all ON public.session;
CREATE POLICY session_project_access_all
ON public.session
FOR ALL
TO authenticated
USING (
  project_id IN (
    SELECT id FROM public.project
    WHERE user_id = auth.jwt() ->> 'sub'
       OR COALESCE(shared_users, ARRAY[]::text[]) @> ARRAY[auth.jwt() ->> 'sub']
  )
)
WITH CHECK (
  project_id IN (
    SELECT id FROM public.project
    WHERE user_id = auth.jwt() ->> 'sub'
       OR COALESCE(shared_users, ARRAY[]::text[]) @> ARRAY[auth.jwt() ->> 'sub']
  )
);

DROP POLICY IF EXISTS session_service_role_all ON public.session;
CREATE POLICY session_service_role_all
ON public.session
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ============================= chat =============================
ALTER TABLE public.chat ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.chat FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat TO authenticated;

-- Read: any collaborator who can access the project (matches current behavior).
DROP POLICY IF EXISTS chat_project_select ON public.chat;
CREATE POLICY chat_project_select
ON public.chat
FOR SELECT
TO authenticated
USING (
  project_id IN (
    SELECT id FROM public.project
    WHERE user_id = auth.jwt() ->> 'sub'
       OR COALESCE(shared_users, ARRAY[]::text[]) @> ARRAY[auth.jwt() ->> 'sub']
  )
);

-- Insert: caller must author as themselves AND into a project they can access.
DROP POLICY IF EXISTS chat_author_insert ON public.chat;
CREATE POLICY chat_author_insert
ON public.chat
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.jwt() ->> 'sub'
  AND project_id IN (
    SELECT id FROM public.project
    WHERE user_id = auth.jwt() ->> 'sub'
       OR COALESCE(shared_users, ARRAY[]::text[]) @> ARRAY[auth.jwt() ->> 'sub']
  )
);

-- Edit/delete: author-only (a collaborator cannot alter another user's messages).
DROP POLICY IF EXISTS chat_author_update ON public.chat;
CREATE POLICY chat_author_update
ON public.chat
FOR UPDATE
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS chat_author_delete ON public.chat;
CREATE POLICY chat_author_delete
ON public.chat
FOR DELETE
TO authenticated
USING (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS chat_service_role_all ON public.chat;
CREATE POLICY chat_service_role_all
ON public.chat
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
