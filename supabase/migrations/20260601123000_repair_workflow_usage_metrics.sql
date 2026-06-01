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

ALTER TABLE public.workflow_usage
ADD COLUMN IF NOT EXISTS note_id TEXT,
ADD COLUMN IF NOT EXISTS user_id TEXT,
ADD COLUMN IF NOT EXISTS stage TEXT,
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'google-gemini',
ADD COLUMN IF NOT EXISTS model TEXT,
ADD COLUMN IF NOT EXISTS input_type TEXT DEFAULT 'text',
ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS candidates_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS cached_content_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS thoughts_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS latency_ms INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12, 6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS usage_metadata JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.workflow_usage
SET
  provider = COALESCE(NULLIF(provider, ''), 'google-gemini'),
  input_type = COALESCE(NULLIF(input_type, ''), 'text'),
  prompt_tokens = COALESCE(prompt_tokens, 0),
  candidates_tokens = COALESCE(candidates_tokens, 0),
  total_tokens = COALESCE(total_tokens, 0),
  cached_content_tokens = COALESCE(cached_content_tokens, 0),
  thoughts_tokens = COALESCE(thoughts_tokens, 0),
  latency_ms = COALESCE(latency_ms, 0),
  estimated_cost_usd = COALESCE(estimated_cost_usd, 0),
  usage_metadata = COALESCE(usage_metadata, '{}'::jsonb),
  created_at = COALESCE(created_at, NOW()),
  user_id = COALESCE(NULLIF(user_id, ''), 'unknown'),
  stage = COALESCE(NULLIF(stage, ''), 'unknown'),
  model = COALESCE(NULLIF(model, ''), 'unknown');

ALTER TABLE public.workflow_usage
ALTER COLUMN user_id SET NOT NULL,
ALTER COLUMN stage SET NOT NULL,
ALTER COLUMN provider SET NOT NULL,
ALTER COLUMN provider SET DEFAULT 'google-gemini',
ALTER COLUMN model SET NOT NULL,
ALTER COLUMN input_type SET NOT NULL,
ALTER COLUMN input_type SET DEFAULT 'text',
ALTER COLUMN prompt_tokens SET NOT NULL,
ALTER COLUMN prompt_tokens SET DEFAULT 0,
ALTER COLUMN candidates_tokens SET NOT NULL,
ALTER COLUMN candidates_tokens SET DEFAULT 0,
ALTER COLUMN total_tokens SET NOT NULL,
ALTER COLUMN total_tokens SET DEFAULT 0,
ALTER COLUMN cached_content_tokens SET NOT NULL,
ALTER COLUMN cached_content_tokens SET DEFAULT 0,
ALTER COLUMN thoughts_tokens SET NOT NULL,
ALTER COLUMN thoughts_tokens SET DEFAULT 0,
ALTER COLUMN latency_ms SET NOT NULL,
ALTER COLUMN latency_ms SET DEFAULT 0,
ALTER COLUMN estimated_cost_usd SET NOT NULL,
ALTER COLUMN estimated_cost_usd SET DEFAULT 0,
ALTER COLUMN usage_metadata SET NOT NULL,
ALTER COLUMN usage_metadata SET DEFAULT '{}'::jsonb,
ALTER COLUMN created_at SET NOT NULL,
ALTER COLUMN created_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS workflow_usage_user_id_idx ON public.workflow_usage (user_id);
CREATE INDEX IF NOT EXISTS workflow_usage_note_id_idx ON public.workflow_usage (note_id);
CREATE INDEX IF NOT EXISTS workflow_usage_stage_provider_idx ON public.workflow_usage (stage, provider);
CREATE INDEX IF NOT EXISTS workflow_usage_created_at_idx ON public.workflow_usage (created_at DESC);

ALTER TABLE public.workflow_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_usage_service_role_all ON public.workflow_usage;
CREATE POLICY workflow_usage_service_role_all
ON public.workflow_usage
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
