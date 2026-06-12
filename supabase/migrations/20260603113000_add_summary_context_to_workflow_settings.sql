ALTER TABLE public.workflow_transcription_settings
ADD COLUMN IF NOT EXISTS summary_context TEXT NOT NULL DEFAULT '';
