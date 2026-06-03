CREATE TABLE IF NOT EXISTS public.workflow_transcription_settings (
  id TEXT PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  speech_model TEXT NOT NULL DEFAULT 'universal-3-pro',
  keyterms_prompt TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  custom_spelling JSONB NOT NULL DEFAULT '[]'::JSONB,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.workflow_transcription_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_transcription_settings_service_role_all
ON public.workflow_transcription_settings;

CREATE POLICY workflow_transcription_settings_service_role_all
ON public.workflow_transcription_settings
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

INSERT INTO public.workflow_transcription_settings (id, speech_model)
VALUES ('global', 'universal-3-pro')
ON CONFLICT (id) DO NOTHING;
