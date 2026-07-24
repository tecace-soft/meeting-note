CREATE TABLE IF NOT EXISTS public.workflow_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  note_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_job_user_id_idx ON public.workflow_job (user_id);
CREATE INDEX IF NOT EXISTS workflow_job_note_id_idx ON public.workflow_job (note_id);
CREATE INDEX IF NOT EXISTS workflow_job_created_at_idx ON public.workflow_job (created_at DESC);

ALTER TABLE public.workflow_job ENABLE ROW LEVEL SECURITY;
