ALTER TABLE public.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.speaker ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summary_prompt ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.app_user TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.speaker TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.summary_prompt TO authenticated;

DROP POLICY IF EXISTS app_user_self_select ON public.app_user;
CREATE POLICY app_user_self_select
ON public.app_user
FOR SELECT
TO authenticated
USING (microsoft_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS app_user_self_insert ON public.app_user;
CREATE POLICY app_user_self_insert
ON public.app_user
FOR INSERT
TO authenticated
WITH CHECK (microsoft_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS app_user_self_update ON public.app_user;
CREATE POLICY app_user_self_update
ON public.app_user
FOR UPDATE
TO authenticated
USING (microsoft_id = auth.jwt() ->> 'sub')
WITH CHECK (microsoft_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS file_owner_all ON public.file;
CREATE POLICY file_owner_all
ON public.file
FOR ALL
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS note_owner_select ON public.note;
CREATE POLICY note_owner_select
ON public.note
FOR SELECT
TO authenticated
USING (
  user_id = auth.jwt() ->> 'sub'
  OR COALESCE(shared_users, ARRAY[]::text[]) @> ARRAY[auth.jwt() ->> 'sub']
);

DROP POLICY IF EXISTS note_owner_insert ON public.note;
CREATE POLICY note_owner_insert
ON public.note
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS note_owner_update ON public.note;
CREATE POLICY note_owner_update
ON public.note
FOR UPDATE
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS note_owner_delete ON public.note;
CREATE POLICY note_owner_delete
ON public.note
FOR DELETE
TO authenticated
USING (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS project_owner_all ON public.project;
CREATE POLICY project_owner_all
ON public.project
FOR ALL
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS speaker_owner_all ON public.speaker;
CREATE POLICY speaker_owner_all
ON public.speaker
FOR ALL
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS summary_prompt_owner_all ON public.summary_prompt;
CREATE POLICY summary_prompt_owner_all
ON public.summary_prompt
FOR ALL
TO authenticated
USING (user_id = auth.jwt() ->> 'sub')
WITH CHECK (user_id = auth.jwt() ->> 'sub');

DROP POLICY IF EXISTS app_user_service_role_all ON public.app_user;
CREATE POLICY app_user_service_role_all
ON public.app_user
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS file_service_role_all ON public.file;
CREATE POLICY file_service_role_all
ON public.file
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS note_service_role_all ON public.note;
CREATE POLICY note_service_role_all
ON public.note
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS project_service_role_all ON public.project;
CREATE POLICY project_service_role_all
ON public.project
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS speaker_service_role_all ON public.speaker;
CREATE POLICY speaker_service_role_all
ON public.speaker
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS summary_prompt_service_role_all ON public.summary_prompt;
CREATE POLICY summary_prompt_service_role_all
ON public.summary_prompt
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
