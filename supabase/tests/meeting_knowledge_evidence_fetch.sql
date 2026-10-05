-- Isolated synthetic DB only: fixture + ledger + outbox + evidence migrations.
begin;
create temp table evidence_checks (name text primary key);
grant select,insert on evidence_checks to service_role;
create function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %',label; end if;
  insert into evidence_checks values(label);
end $$;
create function pg_temp.fetch(object_id uuid, patch jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare binding jsonb;
begin
  binding := public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','evidence-note') || patch;
  return public.meeting_knowledge_current_evidence((binding->>'tenantId')::uuid,binding->>'sourceId',object_id,
    (binding->>'contentRevision')::bigint,(binding->>'speakerRevision')::bigint,(binding->>'accessRevision')::bigint,
    (binding->>'integrationGeneration')::bigint,binding->>'sourceHash');
end $$;
insert into public.note(id,user_id,transcription,shared_users,projects) values
 ('evidence-note','22222222-2222-4222-8222-000000000001',E'Original 😀 evidence.\n한국어 second line.',
  array['22222222-2222-4222-8222-000000000002'],array['evidence-project','foreign-project']);
insert into public.project values
 ('evidence-project','22222222-2222-4222-8222-000000000001',array['22222222-2222-4222-8222-000000000003']),
 ('foreign-project','22222222-2222-4222-8222-000000000004',array['22222222-2222-4222-8222-000000000004']);
select pg_temp.expect(not has_function_privilege('anon','public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text)','EXECUTE'),'anon cannot execute evidence RPC');
select pg_temp.expect(not has_function_privilege('authenticated','public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text)','EXECUTE'),'authenticated cannot execute evidence RPC');
select pg_temp.expect(has_function_privilege('service_role','public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text)','EXECUTE'),'service role evidence grant');
select pg_temp.expect((select not prosecdef from pg_proc where oid='public.meeting_knowledge_current_evidence(uuid,text,uuid,bigint,bigint,bigint,bigint,text)'::regprocedure),'evidence function security invoker');
set local role service_role;
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'disabled source cannot return content');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',1,'enable');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000001') is null,'owner is not automatically audience');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002')->>'plaintext'=E'Original 😀 evidence.\n한국어 second line.','direct share retrieves exact original UTF8');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000003') is not null,'same owner project share retrieves');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000004') is null,'foreign project owner grants no access');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000005') is null,'unshared canonical identity denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002')->'record'->>'sourceHash'
 =encode(sha256(convert_to(E'Original 😀 evidence.\n한국어 second line.','UTF8')),'hex'),'RPC record hash binds original plaintext');
select pg_temp.expect(not(pg_temp.fetch('22222222-2222-4222-8222-000000000002') ?| array['title','summary','name','sourceUrl']),'snapshot has no presentation metadata');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"contentRevision":2}') is null,'content revision mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"speakerRevision":2}') is null,'speaker revision mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"accessRevision":1}') is null,'access revision mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"integrationGeneration":1}') is null,'generation mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002',jsonb_build_object('sourceHash',repeat('a',64))) is null,'hash mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"tenantId":"33333333-3333-4333-8333-333333333333"}') is null,'tenant mismatch denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"sourceId":"unknown-note"}') is null,'unknown source denied');
select pg_temp.expect(pg_temp.fetch(null) is null,'null identity denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"contentRevision":0}') is null,'invalid revision denied');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"sourceHash":"not-a-hash"}') is null,'malformed hash denied');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',2,'confirm_participant','22222222-2222-4222-8222-000000000005','synthetic-owner-confirmation');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000005') is not null,'confirmed participant retrieves');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',3,'revoke','22222222-2222-4222-8222-000000000005');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000005') is null,'denial overrides attendance');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',4,'revoke','22222222-2222-4222-8222-000000000002');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'denial overrides direct share');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',5,'revoke','22222222-2222-4222-8222-000000000003');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000003') is null,'denial overrides project share');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','evidence-note','22222222-2222-4222-8222-000000000001',6,'restore','22222222-2222-4222-8222-000000000002');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is not null,'restored direct share retrieves');
update public.note set transcription=transcription||' Edit.' where id='evidence-note';
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002','{"contentRevision":1}') is null,'edit invalidates old content binding');
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002')->>'plaintext' like '%Edit.','new binding retrieves edited content');
update public.note set shared_users='{}' where id='evidence-note';
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'legacy direct unshare immediately denies');
update public.note set shared_users=array['22222222-2222-4222-8222-000000000002'],transcription=repeat('x',1048577) where id='evidence-note';
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'oversized transcript never returned');
update public.note set transcription=null where id='evidence-note';
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'removed transcript denied');
update public.note set transcription='Synthetic replacement' where id='evidence-note';
delete from public.note where id='evidence-note';
select pg_temp.expect(pg_temp.fetch('22222222-2222-4222-8222-000000000002') is null,'deleted note denied');
reset role;
select count(*) as passed_evidence_checks from evidence_checks;
rollback;
