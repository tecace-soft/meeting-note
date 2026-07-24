CREATE TABLE IF NOT EXISTS public.workflow_usage (
  id BIGSERIAL PRIMARY KEY,
  note_id TEXT,
  user_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google-gemini',
  model TEXT NOT NULL,
  input_type TEXT NOT NULL DEFAULT 'text',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  candidates_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_content_tokens INTEGER NOT NULL DEFAULT 0,
  thoughts_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  usage_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workflow_usage_user_id_idx ON public.workflow_usage (user_id);
CREATE INDEX IF NOT EXISTS workflow_usage_note_id_idx ON public.workflow_usage (note_id);
CREATE INDEX IF NOT EXISTS workflow_usage_created_at_idx ON public.workflow_usage (created_at DESC);

ALTER TABLE public.workflow_usage ENABLE ROW LEVEL SECURITY;
