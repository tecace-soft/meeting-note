UPDATE storage.buckets
SET public = false
WHERE id = 'meeting-recordings';

DROP POLICY IF EXISTS meeting_recordings_authenticated_select ON storage.objects;
CREATE POLICY meeting_recordings_authenticated_select
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'meeting-recordings');

DROP POLICY IF EXISTS meeting_recordings_authenticated_insert ON storage.objects;
CREATE POLICY meeting_recordings_authenticated_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'meeting-recordings');

DROP POLICY IF EXISTS meeting_recordings_authenticated_update ON storage.objects;
CREATE POLICY meeting_recordings_authenticated_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'meeting-recordings')
WITH CHECK (bucket_id = 'meeting-recordings');

DROP POLICY IF EXISTS meeting_recordings_authenticated_delete ON storage.objects;
CREATE POLICY meeting_recordings_authenticated_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'meeting-recordings');
