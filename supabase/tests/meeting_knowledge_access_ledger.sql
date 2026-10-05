-- Run ONLY after fixture_schema.sql + the new migration in an isolated local DB.
-- Transaction rollback leaves the synthetic database unchanged.
begin;
create temp table ledger_checks (name text primary key);
grant select, insert on ledger_checks to service_role, authenticated, anon;
create function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %', label; end if;
  insert into ledger_checks values(label);
end $$;
create function pg_temp.expect_error(statement text, expected_state text, expected_message text, label text)
returns void language plpgsql as $$
declare actual_state text; actual_message text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_state = returned_sqlstate, actual_message = message_text;
  end;
  perform pg_temp.expect(actual_state = expected_state and (expected_message is null or actual_message = expected_message), label);
end $$;
insert into public.note(id,user_id,transcription,diarization,summary,shared_users,projects) values
 ('synthetic-note','22222222-2222-4222-8222-000000000001',E'Synthetic raw transcript.\nSecond line.', '[]','Different synthetic summary',
  array['22222222-2222-4222-8222-000000000002','Speaker A','BAD-ID'],array['synthetic-project','foreign-project']),
 ('synthetic-empty','22222222-2222-4222-8222-000000000001',null,'[{"text":"Diarization only"}]','Synthetic summary','{}','{}'),
 ('synthetic-owner-change','22222222-2222-4222-8222-000000000001','Synthetic content','[]',null,'{}','{}');
insert into public.project values
 ('synthetic-project','22222222-2222-4222-8222-000000000001',array['22222222-2222-4222-8222-000000000003']),
 ('foreign-project','22222222-2222-4222-8222-000000000004',array['22222222-2222-4222-8222-000000000002']);

select pg_temp.expect(not has_schema_privilege('authenticated','meeting_knowledge','USAGE'), 'private schema denies authenticated usage');
select pg_temp.expect(not has_schema_privilege('anon','meeting_knowledge','USAGE'), 'private schema denies anon usage');
select pg_temp.expect(not has_table_privilege('authenticated','meeting_knowledge.source','SELECT'), 'source table has no browser grant');
select pg_temp.expect(not has_function_privilege('authenticated','public.meeting_knowledge_initialize(uuid,text,uuid)','EXECUTE'), 'initialize RPC denies browser');
select pg_temp.expect(not has_function_privilege('anon','public.meeting_knowledge_current_source(uuid,text)','EXECUTE'), 'current RPC denies anon');
select pg_temp.expect(not has_function_privilege('service_role','meeting_knowledge.note_changed()','EXECUTE'), 'private definer trigger has no direct service execute grant');
select pg_temp.expect((select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'meeting_knowledge_%'), 'all public ledger RPCs use invoker security');
select pg_temp.expect((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='meeting_knowledge' and c.relkind='r'), 'all private tables have RLS');

set local role authenticated;
select pg_temp.expect_error($sql$select public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-note')$sql$,
 '42501',null,'browser cannot execute source RPC');
reset role;
set local role service_role;
select pg_temp.expect_error($sql$select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000002')$sql$,
 'P0001','SOURCE_UNAVAILABLE','shared user cannot claim enrollment ownership');
select pg_temp.expect_error($sql$select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-empty','22222222-2222-4222-8222-000000000001')$sql$,
 'P0001','SOURCE_UNAVAILABLE','diarization-only note fails closed');
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001');
select pg_temp.expect((select not integration_enabled and access_revision=1 from meeting_knowledge.source where source_id='synthetic-note'), 'enrollment disabled with revision one');
select pg_temp.expect((public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-note')->>'sourceHash')
 = encode(sha256(convert_to(E'Synthetic raw transcript.\nSecond line.','UTF8')),'hex'), 'hash binds exact raw transcript');
select pg_temp.expect(jsonb_array_length(public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-note')->'directShares')=1,
 'invalid legacy share labels are excluded');
select pg_temp.expect(jsonb_array_length(public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-note')->'projects')=1,
 'foreign owner project never grants access');
select pg_temp.expect(not (public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-note') ?| array['transcription','summary','title']),
 'record contains no transcript summary or title');
select pg_temp.expect(public.meeting_knowledge_current_source('33333333-3333-4333-8333-333333333333','synthetic-note') is null,
 'foreign tenant cannot fetch source record');
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001');
select pg_temp.expect((select count(*)=1 from meeting_knowledge.access_event where source_id='synthetic-note'), 'repeat enrollment is idempotent');
select pg_temp.expect_error($sql$select public.meeting_knowledge_initialize('33333333-3333-4333-8333-333333333333','synthetic-note','22222222-2222-4222-8222-000000000001')$sql$,
 'P0001','SOURCE_UNAVAILABLE','tenant association is immutable');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',1,'confirm_participant','22222222-2222-4222-8222-000000000002','synthetic-owner-confirmation');
select pg_temp.expect((select access_revision=2 from meeting_knowledge.source where source_id='synthetic-note'), 'attendance changes access revision');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',2,'confirm_participant','22222222-2222-4222-8222-000000000002','synthetic-owner-confirmation');
select pg_temp.expect((select access_revision=2 from meeting_knowledge.source where source_id='synthetic-note'), 'same attendance evidence is no-op');
select pg_temp.expect_error($sql$select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',1,'enable')$sql$,
 'P0001','ACCESS_REVISION_CONFLICT','stale access revision cannot mutate');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',2,'revoke','22222222-2222-4222-8222-000000000002');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',3,'confirm_participant','22222222-2222-4222-8222-000000000002','synthetic-new-evidence');
select pg_temp.expect((select active from meeting_knowledge.denial where source_id='synthetic-note' and object_id='22222222-2222-4222-8222-000000000002'), 'confirmation does not remove deny');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',4,'restore','22222222-2222-4222-8222-000000000002');
select pg_temp.expect((select not active from meeting_knowledge.denial where source_id='synthetic-note' and object_id='22222222-2222-4222-8222-000000000002'), 'restore deactivates deny without deleting history');
select pg_temp.expect((select count(*)=1 from meeting_knowledge.access_event where source_id='synthetic-note' and action='revoke'), 'restore preserves revoke audit');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',5,'enable');
select pg_temp.expect((select integration_enabled and integration_generation=2 from meeting_knowledge.source where source_id='synthetic-note'), 'first enable starts a new integration generation');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',6,'disable');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001',7,'enable');
select pg_temp.expect((select integration_enabled and integration_generation=3 and access_revision=8 from meeting_knowledge.source where source_id='synthetic-note'), 're-enable invalidates prior generation');
reset role;

-- Browser changes invoke the private trigger without private-schema privileges.
set local role authenticated;
update public.note set summary='Changed synthetic summary' where id='synthetic-note';
reset role;
select pg_temp.expect((select content_revision=1 and access_revision=8 from meeting_knowledge.source where source_id='synthetic-note'), 'summary edits do not change raw-source revisions');
set local role authenticated;
update public.note set transcription=transcription || ' Extra raw text.' where id='synthetic-note';
update public.note set diarization='[{"speaker":"Synthetic Speaker","text":"Synthetic text"}]' where id='synthetic-note';
reset role;
select pg_temp.expect((select content_revision=3 and speaker_revision=2 from meeting_knowledge.source where source_id='synthetic-note'), 'browser raw transcript and diarization edits invalidate revisions');
set local role authenticated;
update public.note set shared_users='{}' where id='synthetic-note';
update public.project set shared_users='{}' where id='synthetic-project';
delete from public.project where id='synthetic-project';
insert into public.project values('synthetic-project','22222222-2222-4222-8222-000000000001',array['22222222-2222-4222-8222-000000000003']);
insert into public.speaker values('synthetic-speaker','22222222-2222-4222-8222-000000000001','Synthetic Speaker');
update public.speaker set name='Synthetic Renamed Speaker' where id='synthetic-speaker';
delete from public.speaker where id='synthetic-speaker';
reset role;
select pg_temp.expect((select access_revision=12 and speaker_revision=5 from meeting_knowledge.source where source_id='synthetic-note'), 'direct/project shares deletion reuse and speaker edits invalidate');
set local role service_role;
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-owner-change','22222222-2222-4222-8222-000000000001');
update public.note set user_id='22222222-2222-4222-8222-000000000004' where id='synthetic-owner-change';
update public.note set user_id='22222222-2222-4222-8222-000000000001' where id='synthetic-owner-change';
select pg_temp.expect(public.meeting_knowledge_current_source('11111111-1111-4111-8111-111111111111','synthetic-owner-change') is null, 'owner roundtrip does not revive old audience');
select pg_temp.expect_error($sql$select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-owner-change','22222222-2222-4222-8222-000000000001')$sql$,
 'P0001','SOURCE_UNAVAILABLE','tombstoned ownership cannot re-enroll');
delete from public.note where id='synthetic-note';
select pg_temp.expect((select not active and not integration_enabled from meeting_knowledge.source where source_id='synthetic-note'), 'note deletion persists independent tombstone');
select pg_temp.expect((select count(*)>0 from meeting_knowledge.access_event where source_id='synthetic-note'), 'note deletion preserves access audit');
insert into public.note(id,user_id,transcription) values('synthetic-note','22222222-2222-4222-8222-000000000001','Synthetic replacement');
select pg_temp.expect_error($sql$select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','synthetic-note','22222222-2222-4222-8222-000000000001')$sql$,
 'P0001','SOURCE_UNAVAILABLE','reusing deleted note ID cannot resurrect source');
reset role;
select count(*) as passed_ledger_checks from ledger_checks;
rollback;
