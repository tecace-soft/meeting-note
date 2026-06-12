ALTER TABLE public.mcp_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.mcp_token FROM anon, authenticated;
REVOKE ALL ON public.workflow_job FROM anon, authenticated;
REVOKE ALL ON public.workflow_usage FROM anon, authenticated;

DROP POLICY IF EXISTS mcp_token_service_role_all ON public.mcp_token;
CREATE POLICY mcp_token_service_role_all
ON public.mcp_token
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS workflow_job_service_role_all ON public.workflow_job;
CREATE POLICY workflow_job_service_role_all
ON public.workflow_job
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS workflow_usage_service_role_all ON public.workflow_usage;
CREATE POLICY workflow_usage_service_role_all
ON public.workflow_usage
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
