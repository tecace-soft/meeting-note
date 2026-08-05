-- Raise the meeting-recordings audio bucket per-file upload limit from the
-- Supabase free-tier default (50MB) to 200MB, now that the project is on Pro.
-- This unblocks long / high-bitrate recordings that previously failed to upload.
--
-- IMPORTANT: the effective upload cap is min(project-wide limit, bucket limit).
-- The project-wide storage upload limit must ALSO be raised to >= 200MB in the
-- Supabase dashboard (Storage > Settings > Upload file size limit). Until that
-- is done this bucket value has no effect and uploads stay capped at 50MB.
--
-- 200MB = 200 * 1024 * 1024 = 209715200 bytes.
update storage.buckets
set file_size_limit = 209715200
where id = 'meeting-recordings';
