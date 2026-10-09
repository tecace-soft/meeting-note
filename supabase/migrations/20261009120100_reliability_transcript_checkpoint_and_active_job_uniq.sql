-- Two linked reliability fixes for the summarize-audio pipeline.
--
-- NOTE: this migration is intentionally NOT applied to any database by the
-- backend code. The workflow-server degrades gracefully without it (the
-- transcript checkpoint read/write are best-effort and fail-soft, and the
-- duplicate-pipeline guard is defensive code that simply never triggers while
-- the partial index is absent). Apply it deliberately when ready.

-- FIX 2: transcribe -> summarize checkpoint.
-- Persist the paid AssemblyAI transcript (diarized segments) keyed by note_id
-- after transcription succeeds and before the Gemini summary call, so a summary
-- failure or a process restart no longer discards it and forces a full
-- re-transcription on retry. Keyed by note_id (not job id) so it survives across
-- job retries -- the mobile client reuses note_id when it retries. The row is
-- deleted once the note (which embeds the transcript) is durably persisted, so
-- the table only ever holds in-flight transcripts.
CREATE TABLE IF NOT EXISTS public.workflow_transcript_checkpoint (
  note_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  segments JSONB NOT NULL,
  audio_duration_seconds DOUBLE PRECISION,
  detected_language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_transcript_checkpoint_user_id_idx
  ON public.workflow_transcript_checkpoint (user_id);

-- Backend-only table: written and read solely by the workflow server via the
-- service role. Mirror the workflow_job / workflow_usage lockdown (RLS on, no
-- anon/authenticated grants, service_role bypass policy).
ALTER TABLE public.workflow_transcript_checkpoint ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.workflow_transcript_checkpoint FROM anon, authenticated;

DROP POLICY IF EXISTS workflow_transcript_checkpoint_service_role_all ON public.workflow_transcript_checkpoint;
CREATE POLICY workflow_transcript_checkpoint_service_role_all
ON public.workflow_transcript_checkpoint
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- FIX 1: at most one ACTIVE pipeline per (user_id, note_id).
-- The idempotency SELECT in createSummarizeJob is check-then-insert and so is
-- racy: two concurrent requests for the same note can both start a full
-- transcribe+summary run, duplicating the note and double-billing. This partial
-- unique index closes that race at the database. It is PARTIAL on purpose: it
-- constrains only queued/processing rows, so a genuine retry after a 'failed' or
-- 'completed' job (same note_id) is still allowed. The backend treats the
-- resulting unique_violation as a dedup hit and returns the existing job.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_job_active_note_uniq
  ON public.workflow_job (user_id, note_id)
  WHERE status IN ('queued', 'processing') AND note_id IS NOT NULL;
