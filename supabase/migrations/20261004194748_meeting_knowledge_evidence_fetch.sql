-- Inactive, service-only evidence fetch. No content is copied to a new table.
-- Apply after the source ledger/outbox. Rollback: disable ACCESS_ENABLED then
-- drop this RPC; existing source delivery/extraction tables remain unchanged.
begin;
create or replace function public.meeting_knowledge_current_evidence(
  p_tenant_id uuid, p_source_id text, p_object_id uuid,
  p_content_revision bigint, p_speaker_revision bigint, p_access_revision bigint,
  p_integration_generation bigint, p_source_hash text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_record jsonb; identity jsonb; plaintext text;
begin
  if p_tenant_id is null or p_object_id is null or p_source_id is null
    or length(p_source_id) not between 1 and 256
    or p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$'
    or p_content_revision is null or p_content_revision not between 1 and 9007199254740991
    or p_speaker_revision is null or p_speaker_revision not between 1 and 9007199254740991
    or p_access_revision is null or p_access_revision not between 1 and 9007199254740991
    or p_integration_generation is null or p_integration_generation not between 1 and 9007199254740991 then return null; end if;
  -- Same lock order as management and legacy note edits: note, then source.
  -- Source locks serialize participant/denial, project-share and speaker fanout
  -- triggers. The final HTTP-side live check also fences changes after RPC exit.
  perform 1 from public.note n join meeting_knowledge.source s on s.source_id = n.id::text
    where s.source_id = p_source_id and s.tenant_id = p_tenant_id and s.active and s.integration_enabled
      and lower(n.user_id) = s.owner_object_id::text
      and n.transcription is not null and octet_length(n.transcription) between 1 and 1048576
    for share of n;
  if not found then return null; end if;
  perform 1 from meeting_knowledge.source s where s.source_id = p_source_id
    and s.tenant_id = p_tenant_id and s.active and s.integration_enabled for share;
  if not found then return null; end if;
  current_record := public.meeting_knowledge_current_source(p_tenant_id,p_source_id);
  if current_record is null or not (current_record @> jsonb_build_object(
    'tenantId',p_tenant_id::text,'sourceId',p_source_id,'contentRevision',p_content_revision,
    'speakerRevision',p_speaker_revision,'accessRevision',p_access_revision,
    'integrationGeneration',p_integration_generation,'sourceHash',p_source_hash,
    'active',true,'integrationEnabled',true,'ownerIdentityVerified',true)) then return null; end if;
  identity := jsonb_build_object('tenantId',p_tenant_id::text,'objectId',p_object_id::text);
  if current_record->'denies' @> jsonb_build_array(identity) then return null; end if;
  -- Management ownership never grants retrieval. Only confirmed audience/shares.
  if not (
    current_record->'directShares' @> jsonb_build_array(identity)
    or current_record->'confirmedParticipants' @> jsonb_build_array(jsonb_build_object(
      'identity',identity,'confirmedBy',current_record->'owner'))
    or exists (select 1 from jsonb_array_elements(current_record->'projects') project
      where project->'sharedWith' @> jsonb_build_array(identity))
  ) then return null; end if;
  select n.transcription into plaintext from public.note n where n.id::text = p_source_id;
  if plaintext is null or octet_length(plaintext) not between 1 and 1048576
    or encode(sha256(convert_to(plaintext,'UTF8')),'hex') <> p_source_hash then return null; end if;
  return jsonb_build_object('record',current_record,'plaintext',plaintext);
end $$;
revoke all on function public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text)
  from public,anon,authenticated;
grant execute on function public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text) to service_role;
commit;
