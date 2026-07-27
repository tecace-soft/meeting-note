WITH ranked_defaults AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, lower(trim(name))
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS row_number
  FROM public.summary_prompt
  WHERE lower(trim(name)) = 'default'
)
DELETE FROM public.summary_prompt prompt
USING ranked_defaults ranked
WHERE prompt.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS summary_prompt_one_default_per_user_idx
  ON public.summary_prompt (user_id, lower(trim(name)))
  WHERE lower(trim(name)) = 'default';
