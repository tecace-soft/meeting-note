ALTER TABLE public.file
ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS file_user_recorded_at_idx
  ON public.file (user_id, recorded_at DESC);

ALTER TABLE public.note
ADD COLUMN IF NOT EXISTS meeting_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS note_user_meeting_at_idx
  ON public.note (user_id, meeting_at DESC);
