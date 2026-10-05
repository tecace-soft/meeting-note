-- Synthetic isolated DB only; fixture + five meeting-knowledge migrations.
begin;
create temp table operability_checks(name text primary key);
grant select,insert on operability_checks to service_role;
create function pg_temp.op_expect(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',label; end if;
 insert into operability_checks values(label); end $$;
create function pg_temp.op_status() returns jsonb language sql as $$
 select public.meeting_knowledge_owner_status('11111111-1111-4111-8111-111111111111','operability-note','22222222-2222-4222-8222-000000000001'); $$;
create function pg_temp.op_resync(patch jsonb default '{}'::jsonb, actor uuid default '22222222-2222-4222-8222-000000000001') returns jsonb language plpgsql as $$
declare b jsonb:=(pg_temp.op_status()->'processing'->'binding') || patch;
begin return public.meeting_knowledge_owner_resync('11111111-1111-4111-8111-111111111111','operability-note',actor,
 (b->>'contentRevision')::bigint,(b->>'speakerRevision')::bigint,(b->>'accessRevision')::bigint,
 (b->>'integrationGeneration')::bigint,b->>'sourceHash'); end $$;
create function pg_temp.op_error(statement text,wanted text,label text) returns void language plpgsql as $$
declare actual text;begin begin execute statement;exception when others then get stacked diagnostics actual=message_text;end;
 perform pg_temp.op_expect(actual=wanted,label||': actual='||coalesce(actual,'NO_ERROR'));end $$;
insert into public.note(id,user_id,transcription,shared_users) values ('operability-note','22222222-2222-4222-8222-000000000001','Synthetic raw source. 😀',array['22222222-2222-4222-8222-000000000002']);
select pg_temp.op_expect(not has_function_privilege('authenticated','public.meeting_knowledge_owner_resync(uuid,text,uuid,bigint,bigint,bigint,bigint,text)','EXECUTE'),'resync RPC is not browser callable');
select pg_temp.op_expect(not has_schema_privilege('authenticated','meeting_knowledge','USAGE'),'recovery metadata private schema');
set local role service_role;
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'sizing'='ready','unenrolled note sizing visible');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->'binding'='null'::jsonb,'unenrolled no revision binding');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'canResync'='false','unenrolled recovery disabled');
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','operability-note','22222222-2222-4222-8222-000000000001');
select pg_temp.op_error('select pg_temp.op_resync()','SOURCE_UNAVAILABLE','disabled resync denied');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','operability-note','22222222-2222-4222-8222-000000000001',1,'enable');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'deliveryState'='queued','enabled delivery queue visible');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'extractionState'='not-started','no extraction before ACK');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'canResync'='true','current owner can resync');
select pg_temp.op_expect((select bool_and(content_revision=1 and speaker_revision=1 and access_revision=2 and source_hash is not null) from meeting_knowledge.outbox),'queued packet binding metadata populated');
select pg_temp.op_error($s$select pg_temp.op_resync('{"contentRevision":2}')$s$,'ACCESS_REVISION_CONFLICT','stale content fence rejected');
select pg_temp.op_error($s$select pg_temp.op_resync('{"speakerRevision":2}')$s$,'ACCESS_REVISION_CONFLICT','stale speaker fence rejected');
select pg_temp.op_error($s$select pg_temp.op_resync('{"accessRevision":1}')$s$,'ACCESS_REVISION_CONFLICT','stale access fence rejected');
select pg_temp.op_error($s$select pg_temp.op_resync('{"integrationGeneration":1}')$s$,'ACCESS_REVISION_CONFLICT','stale generation fence rejected');
select pg_temp.op_error($s$select pg_temp.op_resync(jsonb_build_object('sourceHash',repeat('a',64)))$s$,'ACCESS_REVISION_CONFLICT','hash fence rejected');
select pg_temp.op_error($s$select pg_temp.op_resync('{}','22222222-2222-4222-8222-000000000002')$s$,'SOURCE_UNAVAILABLE','shared user cannot recover owner source');
select pg_temp.op_resync();select pg_temp.op_resync();
select pg_temp.op_expect((select count(*)=2 from meeting_knowledge.outbox),'resync existing queue idempotent');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'canResync'='false','60 second owner cooldown visible');
select pg_temp.op_expect((select access_revision=2 from meeting_knowledge.source),'resync does not expand or mutate access');
select pg_temp.op_expect((select count(*)=0 from meeting_knowledge.extraction_job),'resync does not call or enqueue extraction before source ACK');
update meeting_knowledge.outbox set status='cancelled',snapshot=null where event_type='source.upsert';
update meeting_knowledge.owner_recovery set last_requested_at=clock_timestamp()-interval '61 seconds';
select pg_temp.op_resync();select pg_temp.op_resync();
select pg_temp.op_expect((select count(*)=1 from meeting_knowledge.outbox where event_type='source.upsert' and status='pending'),'one missing source packet recreated');
select pg_temp.op_expect((select count(*)=3 from meeting_knowledge.outbox),'recovery creates only missing component');
update meeting_knowledge.outbox set last_error_code='DELIVERY_FAILED',available_at=clock_timestamp()+interval '300 seconds' where status='pending';
update meeting_knowledge.owner_recovery set last_requested_at=clock_timestamp()-interval '61 seconds';
select pg_temp.op_resync();
select pg_temp.op_expect((select bool_and(available_at<=clock_timestamp()) from meeting_knowledge.outbox where status='pending'),'owner can advance transient delivery retry');
update meeting_knowledge.outbox set status='delivered',snapshot=null where status='pending';
select pg_temp.op_expect((select bool_and(content_revision is not null and source_hash is not null) from meeting_knowledge.outbox),'ACK purge retains binding metadata');
update meeting_knowledge.owner_recovery set last_requested_at=clock_timestamp()-interval '61 seconds';
select pg_temp.op_resync();
select pg_temp.op_expect((select count(*)=3 from meeting_knowledge.outbox),'delivered current binding is not duplicated');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'deliveryState'='delivered','current delivered state visible');
insert into meeting_knowledge.extraction_job(tenant_id,source_id,integration_generation,content_revision,speaker_revision,source_hash,source_event,plaintext_code_units,status,coverage)
 select tenant_id,source_id,integration_generation,content_revision,speaker_revision,pg_temp.op_status()#>>'{processing,binding,sourceHash}',null,24,'completed',
 '[{"status":"success"},{"status":"failed"},{"status":"skipped"}]'::jsonb from meeting_knowledge.source;
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'extractionState'='partial','partial processing state visible');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'successfulChunks'='1' and pg_temp.op_status()->'processing'->>'failedChunks'='1' and pg_temp.op_status()->'processing'->>'skippedChunks'='1','coverage counts visible without model text');
update meeting_knowledge.owner_recovery set last_requested_at=clock_timestamp()-interval '61 seconds';select pg_temp.op_resync();
select pg_temp.op_expect((select count(*)=1 and bool_and(status='completed') from meeting_knowledge.extraction_job),'owner resync never reruns completed partial extraction');
-- Paid attempts are distinct from queue claims that waited for policy.
update meeting_knowledge.extraction_job set status='leased',attempts=50,provider_attempts=0,
 worker_id='55555555-5555-4555-8555-555555555555',lease_token='66666666-6666-4666-8666-000000000001',lease_until=clock_timestamp()+interval '60 seconds',
 source_event=jsonb_build_object('eventType','source.upsert','sourceApp','meeting-note','tenantId',tenant_id::text,'sourceId',source_id,'integrationGeneration',integration_generation,
 'payload',jsonb_build_object('plaintext','Synthetic raw source. 😀','contentRevision',content_revision,'speakerRevision',speaker_revision,'sourceHash',source_hash));
select pg_temp.op_expect(public.meeting_knowledge_extraction_begin_provider((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000001'),'many unpaid claims do not prevent first paid attempt');
select pg_temp.op_expect(public.meeting_knowledge_extraction_begin_provider((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000001'),'provider marker idempotent within lease');
select pg_temp.op_expect((select provider_attempts=1 from meeting_knowledge.extraction_job),'one paid run budget independent of claims');
select pg_temp.op_expect(public.meeting_knowledge_extraction_fail((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000001','POLICY_DENIED'),'post-model policy denial records failure');
select pg_temp.op_expect((select isfinite(available_at) from meeting_knowledge.extraction_job),'under-budget denial can resume after approval');
update meeting_knowledge.extraction_job set status='leased',worker_id='55555555-5555-4555-8555-555555555555',lease_token='66666666-6666-4666-8666-000000000002',lease_until=clock_timestamp()+interval '60 seconds';
select pg_temp.op_expect(public.meeting_knowledge_extraction_begin_provider((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000002'),'second paid lease admitted');
select public.meeting_knowledge_extraction_fail((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000002','POLICY_DENIED');
update meeting_knowledge.extraction_job set status='leased',worker_id='55555555-5555-4555-8555-555555555555',lease_token='66666666-6666-4666-8666-000000000003',lease_until=clock_timestamp()+interval '60 seconds';
select pg_temp.op_expect(public.meeting_knowledge_extraction_begin_provider((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000003'),'third paid lease admitted');
select pg_temp.op_expect(public.meeting_knowledge_extraction_fail((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000003','POLICY_DENIED'),'third interrupted paid run records hold');
select pg_temp.op_expect((select provider_attempts=3 and not isfinite(available_at) from meeting_knowledge.extraction_job),'paid attempts cap recurring model expense even after policy revocation');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'extractionState'='blocked','model budget hold visible to owner');
update meeting_knowledge.owner_recovery set last_requested_at=clock_timestamp()-interval '61 seconds';select pg_temp.op_resync();
select pg_temp.op_expect((select provider_attempts=3 and not isfinite(available_at) from meeting_knowledge.extraction_job),'owner recovery cannot clear model budget hold');
select pg_temp.op_expect(not public.meeting_knowledge_extraction_begin_provider((select job_id from meeting_knowledge.extraction_job),'55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-000000000003'),'pending held job cannot spend a fourth paid attempt');
update public.note set transcription=repeat(E'\n',160000) where id='operability-note';
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'sizing'='ready','JSON escaped source size checked rather than codepoint count');
update public.note set transcription=repeat(E'\n',460000) where id='operability-note';
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'sizing'='oversized','escaped source oversize visible');
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'canResync'='false','oversized recovery disabled');
select pg_temp.op_error('select pg_temp.op_resync()','SOURCE_TOO_LARGE','oversize resync rejects without truncation');
select pg_temp.op_expect((select length(transcription)=460000 from public.note),'oversized original note retained');
update public.note set transcription='Synthetic shortened source.' where id='operability-note';
select pg_temp.op_expect(pg_temp.op_status()->'processing'->>'sizing'='ready','edited source becomes processable');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','operability-note','22222222-2222-4222-8222-000000000001',2,'disable');
select pg_temp.op_error('select pg_temp.op_resync()','SOURCE_UNAVAILABLE','disabled source cannot resurrect');
delete from public.note where id='operability-note';
select pg_temp.op_error('select pg_temp.op_resync()','SOURCE_UNAVAILABLE','deleted source cannot resurrect');
reset role;
select count(*) as passed_operability_checks from operability_checks;
rollback;
