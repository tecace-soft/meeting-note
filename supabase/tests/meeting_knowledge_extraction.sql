-- Synthetic isolated PostgreSQL only. No provider, remote database, or real notes.
begin;
create temp table extraction_checks(name text primary key);
grant select,insert on extraction_checks to service_role,authenticated,anon;
create function pg_temp.ex_expect(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;insert into extraction_checks values(label);end $$;
create function pg_temp.ex_error(statement text,expected_state text,expected_message text,label text) returns void language plpgsql as $$
declare actual_state text;actual_message text;
begin begin execute statement;exception when others then get stacked diagnostics actual_state=returned_sqlstate,actual_message=message_text;end;
 if actual_state is distinct from expected_state or (expected_message is not null and actual_message is distinct from expected_message) then raise exception 'FAILED %: state % message %',label,actual_state,actual_message;end if;
 perform pg_temp.ex_expect(true,label);end $$;
create temp table extraction_claim(data jsonb);
grant select,insert,update,delete on extraction_claim to service_role;
create function pg_temp.ex_event(o meeting_knowledge.outbox) returns jsonb language sql as $$
  select jsonb_build_object('schemaVersion',1,'eventId',o.event_id::text,'eventSeq',o.event_seq,'integrationGeneration',o.integration_generation,
    'sourceApp','meeting-note','sourceId',o.source_id,'tenantId',o.tenant_id::text,'eventType','source.upsert','payloadHash',repeat('a',64),
    'payload',jsonb_build_object('contentRevision',o.snapshot#>'{record,contentRevision}','speakerRevision',o.snapshot#>'{record,speakerRevision}',
      'sourceHash',o.snapshot#>'{record,sourceHash}','title',o.snapshot->'title','sourceUrl','https://meeting.example.test/notes/synthetic','meetingAt',null,'timezone','UTC',
      'plaintext',o.snapshot->'plaintext','spans',jsonb_build_array(jsonb_build_object('spanId','span-0','start',0,
        'end',length(o.snapshot->>'plaintext')+(select count(*) from regexp_split_to_table(o.snapshot->>'plaintext','') ch where ascii(ch)>65535),
        'textHash',o.snapshot#>'{record,sourceHash}'))));
$$;
-- Delivery fixtures use the real prepare + ACK transaction. Payload hashes are
-- synthetic fixed hash tokens: shared TypeScript tests own canonical validation.
create function pg_temp.ex_deliver(sid text) returns boolean language plpgsql as $$
declare o meeting_knowledge.outbox%rowtype;
begin
  select * into o from meeting_knowledge.outbox where source_id=sid and event_type='source.upsert' and status='pending' order by event_seq desc limit 1;
  if not found then return false;end if;
  update meeting_knowledge.outbox set status='leased',worker_id='44444444-4444-4444-8444-444444444444',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
    where event_id=o.event_id returning * into o;
  perform public.meeting_knowledge_outbox_prepare(o.event_id,o.worker_id,o.lease_token,pg_temp.ex_event(o));
  return public.meeting_knowledge_outbox_ack(o.event_id,o.worker_id,o.lease_token,repeat('a',64));
end $$;
create function pg_temp.ex_payload(c jsonb) returns jsonb language sql as $$
 select jsonb_build_object('contentRevision',c#>'{sourceEvent,payload,contentRevision}','speakerRevision',c#>'{sourceEvent,payload,speakerRevision}',
  'sourceHash',c#>'{sourceEvent,payload,sourceHash}','extractorRun',jsonb_build_object('runId',c->>'jobId','model','synthetic-model','promptVersion','meeting-candidates-v1'),
  'units',jsonb_build_array(jsonb_build_object('unitId',(c->>'jobId')||':0:0','text','Synthetic candidate task','factType','task','speechAct','request','epistemic','reported','lifecycle','candidate',
    'evidence',jsonb_build_array((c#>'{sourceEvent,payload,spans,0}')||jsonb_build_object('sourceId',c->>'sourceId','contentRevision',c#>'{sourceEvent,payload,contentRevision}','sourceHash',c#>'{sourceEvent,payload,sourceHash}')))));
$$;
create function pg_temp.ex_coverage(c jsonb) returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('index',0,'start',0,'end',c#>'{sourceEvent,payload,spans,0,end}',
   'sourceSpanIds',jsonb_build_array('span-0'),'processable',true,'status','success','rawFallback',false,'acceptedCandidates',1,'rejectedCandidates',0));
$$;
create function pg_temp.ex_run(c jsonb) returns jsonb language sql as $$
 select jsonb_build_object('runId',c->>'jobId','model','synthetic-model','promptVersion','meeting-candidates-v1','inputHash',repeat('b',64),'calls',1,
  'usage',jsonb_build_object('inputTokens',null,'outputTokens',null,'totalTokens',null));
$$;
create function pg_temp.ex_complete(p_payload jsonb default null,p_coverage jsonb default null,p_run jsonb default null) returns boolean language sql as $$
 select public.meeting_knowledge_extraction_complete((data->>'jobId')::uuid,'55555555-5555-4555-8555-555555555555',(data->>'leaseToken')::uuid,
   coalesce(p_payload,pg_temp.ex_payload(data)),coalesce(p_coverage,pg_temp.ex_coverage(data)),coalesce(p_run,pg_temp.ex_run(data))) from extraction_claim;
$$;
insert into public.note(id,user_id,transcription,name,shared_users,projects) values
 ('extraction-note','22222222-2222-4222-8222-000000000001','Synthetic 🎤 raw.','Synthetic title','{}','{}');
select pg_temp.ex_expect(not has_table_privilege('authenticated','meeting_knowledge.extraction_job','SELECT'),'browser cannot read extraction raw');
select pg_temp.ex_expect(not has_function_privilege('authenticated','public.meeting_knowledge_extraction_claim(uuid,uuid)','EXECUTE'),'browser cannot claim extraction');
select pg_temp.ex_expect(not has_function_privilege('anon','public.meeting_knowledge_extraction_complete(uuid,uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE'),'anonymous cannot complete extraction');
select pg_temp.ex_expect(not has_function_privilege('service_role','meeting_knowledge.extraction_source_changed()','EXECUTE'),'definer extraction trigger not directly executable');
select pg_temp.ex_expect((select bool_and(not p.prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'meeting_knowledge_%'),'all public extraction and delivery RPCs invoker');
select pg_temp.ex_expect((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='meeting_knowledge' and c.relkind='r'),'all private queue tables have RLS');
set local role service_role;
select public.meeting_knowledge_initialize('11111111-1111-4111-8111-111111111111','extraction-note','22222222-2222-4222-8222-000000000001');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','extraction-note','22222222-2222-4222-8222-000000000001',1,'enable');
select pg_temp.ex_expect((select count(*)=0 from meeting_knowledge.extraction_job),'source creation alone does not queue model work');
savepoint ack_rollback;
select pg_temp.ex_expect(pg_temp.ex_deliver('extraction-note'),'valid delivery ACK succeeds');
select pg_temp.ex_expect((select count(*)=1 from meeting_knowledge.extraction_job),'ACK queues exactly one source extraction job');
rollback to savepoint ack_rollback;
select pg_temp.ex_expect((select count(*)=0 from meeting_knowledge.extraction_job),'ACK rollback also rolls back extraction enqueue');
select pg_temp.ex_expect(pg_temp.ex_deliver('extraction-note'),'committed ACK queues job');
select pg_temp.ex_expect((select plaintext_code_units=17 and source_event#>>'{payload,plaintext}'='Synthetic 🎤 raw.' from meeting_knowledge.extraction_job),'job retains exact source event and UTF16 length');
-- A repeated source event with the same binding does not create another run.
update meeting_knowledge.stream set event_seq=event_seq+1 where source_id='extraction-note';
insert into meeting_knowledge.outbox(source_id,tenant_id,event_seq,integration_generation,event_type,snapshot)
 select s.source_id,s.tenant_id,st.event_seq,s.integration_generation,'source.upsert',
   jsonb_build_object('record',public.meeting_knowledge_current_source(s.tenant_id,s.source_id),'plaintext',n.transcription,'title',n.name,'meetingAt',null)
 from meeting_knowledge.source s join meeting_knowledge.stream st using(source_id) join public.note n on n.id=s.source_id where s.source_id='extraction-note';
select pg_temp.ex_expect(pg_temp.ex_deliver('extraction-note'),'duplicate binding delivery still ACKs');
select pg_temp.ex_expect((select count(*)=1 from meeting_knowledge.extraction_job),'same delivered binding deduplicates durable job');
select pg_temp.ex_expect(jsonb_array_length(public.meeting_knowledge_extraction_claim('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'))=0,'extraction claim tenant fenced');
select pg_temp.ex_error($sql$select public.meeting_knowledge_extraction_claim(null,'44444444-4444-4444-8444-444444444444')$sql$,'P0001','INVALID_EXTRACTION_COMMAND','claim requires tenant');
insert into extraction_claim values(public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444')->0);
select pg_temp.ex_expect((select (select count(*) from jsonb_object_keys(data))=7 and data->>'attempts'='1' from extraction_claim),'claim exact seven fields and durable first attempt');
select pg_temp.ex_expect(jsonb_array_length(public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555'))=0,'live extraction lease cannot be claimed twice');
select pg_temp.ex_expect(public.meeting_knowledge_extraction_current((select (data->>'jobId')::uuid from extraction_claim),'44444444-4444-4444-8444-444444444444',(select (data->>'leaseToken')::uuid from extraction_claim)),'current source gate renews lease');
select pg_temp.ex_expect((select lease_until>clock_timestamp() and lease_until<=clock_timestamp()+interval '60 seconds' from meeting_knowledge.extraction_job),'renewed lease bounded to sixty seconds');
create temp table old_extraction_claim as select * from extraction_claim;
grant select on old_extraction_claim to service_role;
update meeting_knowledge.extraction_job set lease_until=clock_timestamp()-interval '1 second';
select pg_temp.ex_expect(not public.meeting_knowledge_extraction_current((select (data->>'jobId')::uuid from extraction_claim),'44444444-4444-4444-8444-444444444444',(select (data->>'leaseToken')::uuid from extraction_claim)),'expired lease cannot heartbeat');
update extraction_claim set data=public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')->0;
select pg_temp.ex_expect((select data->>'attempts'='2' from extraction_claim),'crashed worker job reclaimed with same run and next attempt');
select pg_temp.ex_expect((select data->>'jobId'=(select data->>'jobId' from old_extraction_claim) from extraction_claim),'reclaim preserves job ID as run identity');
select pg_temp.ex_expect(not public.meeting_knowledge_extraction_current((select (data->>'jobId')::uuid from old_extraction_claim),'44444444-4444-4444-8444-444444444444',(select (data->>'leaseToken')::uuid from old_extraction_claim)),'old worker cannot renew newer lease');
select pg_temp.ex_expect(not public.meeting_knowledge_extraction_complete((select (data->>'jobId')::uuid from old_extraction_claim),'44444444-4444-4444-8444-444444444444',(select (data->>'leaseToken')::uuid from old_extraction_claim),'{}','[]','{}'),'old worker cannot complete newer lease');
select pg_temp.ex_expect(not public.meeting_knowledge_extraction_fail((select (data->>'jobId')::uuid from old_extraction_claim),'44444444-4444-4444-8444-444444444444',(select (data->>'leaseToken')::uuid from old_extraction_claim),'EXTRACTION_FAILED'),'old worker cannot fail newer lease');
select pg_temp.ex_error($sql$select public.meeting_knowledge_extraction_fail((select (data->>'jobId')::uuid from extraction_claim),'55555555-5555-4555-8555-555555555555',(select (data->>'leaseToken')::uuid from extraction_claim),'raw secret error')$sql$,'P0001','INVALID_EXTRACTION_COMMAND','failure persists only safe error codes');
select pg_temp.ex_expect(public.meeting_knowledge_extraction_fail((select (data->>'jobId')::uuid from extraction_claim),'55555555-5555-4555-8555-555555555555',(select (data->>'leaseToken')::uuid from extraction_claim),'EXTRACTION_FAILED'),'current worker failure releases bounded retry');
select pg_temp.ex_expect((select status='pending' and source_event is not null and available_at>clock_timestamp() and available_at<=clock_timestamp()+interval '300 seconds' from meeting_knowledge.extraction_job),'retry preserves source and bounded backoff');
select pg_temp.ex_expect(jsonb_array_length(public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555'))=0,'backoff prevents immediate model retry');
update meeting_knowledge.extraction_job set available_at=clock_timestamp()-interval '1 second';
update extraction_claim set data=public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')->0;
select pg_temp.ex_expect((select data->>'attempts'='3' from extraction_claim),'durable retry claimed after backoff');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_run=>pg_temp.ex_run((select data from extraction_claim))||'{"runId":"99999999-9999-4999-8999-999999999999"}')$sql$,'P0001','INVALID_EXTRACTION_COMMAND','complete run ID bound to job');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>pg_temp.ex_payload((select data from extraction_claim))||'{"contentRevision":999}')$sql$,'P0001','INVALID_EXTRACTION_COMMAND','complete content revision bound');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_coverage=>jsonb_set(pg_temp.ex_coverage((select data from extraction_claim)),'{0,rawText}','"Forbidden raw copy"'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','coverage cannot contain raw text field');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_run=>pg_temp.ex_run((select data from extraction_claim))||'{"rawText":"Forbidden raw copy"}')$sql$,'P0001','INVALID_EXTRACTION_COMMAND','run provenance cannot contain raw text field');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,epistemic}','"verified"'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','automatic unit cannot claim verified');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,lifecycle}','"confirmed"'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','automatic unit cannot claim confirmed');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,evidence,0,spanId}','"unknown-span"'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','unknown evidence span rejected');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,evidence,0,end}','1'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','changed evidence range rejected');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_coverage=>jsonb_set(pg_temp.ex_coverage((select data from extraction_claim)),'{0,end}','1'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','coverage must cover complete UTF16 input');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,epistemic}','null'))$sql$,'P0001','INVALID_EXTRACTION_COMMAND','null epistemic cannot bypass enum guard');
select pg_temp.ex_error($sql$select pg_temp.ex_complete(p_payload=>jsonb_set(pg_temp.ex_payload((select data from extraction_claim)),'{units,0,text}',to_jsonb(repeat('x',1048577))))$sql$,'P0001','EXTRACTION_PAYLOAD_TOO_LARGE','oversized candidates are held without lossy truncation');
select pg_temp.ex_expect(public.meeting_knowledge_extraction_fail((select (data->>'jobId')::uuid from extraction_claim),'55555555-5555-4555-8555-555555555555',(select (data->>'leaseToken')::uuid from extraction_claim),'PAYLOAD_TOO_LARGE'),'oversize failure preserves a durable operator hold');
select pg_temp.ex_expect((select status='pending' and available_at='infinity'::timestamptz and source_event is not null and last_error_code='PAYLOAD_TOO_LARGE' from meeting_knowledge.extraction_job),'oversize hold retains source without recurring model expense');
select pg_temp.ex_expect(jsonb_array_length(public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555'))=0,'oversize hold is not automatically reclaimed');
-- Synthetic operator repair makes the job eligible again; production requires
-- capacity/budget remediation rather than merely repeating the same oversized run.
update meeting_knowledge.extraction_job set available_at=clock_timestamp()-interval '1 second' where status='pending';
update extraction_claim set data=public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')->0;
-- Simulate expiry during sequence allocation, after the initial lease check.
-- The fixture trigger is temporary to this rolled-back test transaction.
create temp table lease_sequence as select event_seq from meeting_knowledge.stream where source_id='extraction-note';
grant select on lease_sequence to service_role;
reset role;
create function pg_temp.ex_expire_during_sequence() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  update meeting_knowledge.extraction_job set lease_until=clock_timestamp()-interval '1 second'
    where source_id=new.source_id and status='leased';
  return new;
end $$;
create trigger extraction_test_expire before update on meeting_knowledge.stream for each row execute function pg_temp.ex_expire_during_sequence();
set local role service_role;
select pg_temp.ex_error($sql$select pg_temp.ex_complete()$sql$,'P0001','EXTRACTION_LEASE_EXPIRED','lease expiry during sequence allocation rolls completion back');
select pg_temp.ex_expect((select status='leased' and source_event is not null and lease_until>clock_timestamp() from meeting_knowledge.extraction_job),'failed final fence preserves original durable lease and source');
select pg_temp.ex_expect((select count(*)=0 from meeting_knowledge.outbox where event_type='units.upsert'),'failed final fence leaves no orphan units packet');
select pg_temp.ex_expect((select event_seq=(select event_seq from lease_sequence) from meeting_knowledge.stream where source_id='extraction-note'),'failed final fence rolls sequence allocation back');
reset role;
drop trigger extraction_test_expire on meeting_knowledge.stream;
set local role service_role;
savepoint complete_rollback;
select pg_temp.ex_expect(pg_temp.ex_complete(),'completion atomically enqueues units');
select pg_temp.ex_expect((select count(*)=1 from meeting_knowledge.outbox where event_type='units.upsert'),'completion emits exactly one unit event');
rollback to savepoint complete_rollback;
select pg_temp.ex_expect((select status='leased' and source_event is not null from meeting_knowledge.extraction_job),'completion rollback restores raw job and lease');
select pg_temp.ex_expect((select count(*)=0 from meeting_knowledge.outbox where event_type='units.upsert'),'completion rollback removes unit event');
select pg_temp.ex_expect(pg_temp.ex_complete(),'valid completion commits');
select pg_temp.ex_expect((select status='completed' and source_event is null and coverage is not null and run is not null from meeting_knowledge.extraction_job),'completed job retains content-free coverage and run only');
select pg_temp.ex_expect((select not(coverage::text like '%Synthetic%') and not(run::text like '%Synthetic%') from meeting_knowledge.extraction_job),'coverage and provenance retain no transcript or unit text');
select pg_temp.ex_expect((select snapshot ?& array['record','sourceEvent','payload'] and (select count(*) from jsonb_object_keys(snapshot))=3 from meeting_knowledge.outbox where event_type='units.upsert'),'units outbox snapshot exact three keys');
select pg_temp.ex_expect((select snapshot#>>'{payload,extractorRun,runId}'=(select data->>'jobId' from extraction_claim) from meeting_knowledge.outbox where event_type='units.upsert'),'unit publication uses immutable job run identity');
select pg_temp.ex_expect(not pg_temp.ex_complete(),'repeat complete cannot duplicate units');
-- A raw edit fences completed candidates and cancels queued unit copies.
update public.note set transcription='New synthetic 🎤 raw.' where id='extraction-note';
select pg_temp.ex_expect((select status='cancelled' and snapshot is null and prepared_event is null from meeting_knowledge.outbox where event_type='units.upsert'),'raw edit purges stale pending units');
select pg_temp.ex_expect(pg_temp.ex_deliver('extraction-note'),'new revision ACK starts new extraction binding');
update extraction_claim set data=public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')->0;
select pg_temp.ex_expect((select data#>>'{sourceEvent,payload,contentRevision}'='2' from extraction_claim),'new job binds revised source');
update public.note set diarization='[{"text":"Synthetic speaker change"}]' where id='extraction-note';
select pg_temp.ex_expect((select status='cancelled' and source_event is null from meeting_knowledge.extraction_job where job_id=(select (data->>'jobId')::uuid from extraction_claim)),'speaker edit cancels active job and purges source copy');
select pg_temp.ex_expect(not public.meeting_knowledge_extraction_current((select (data->>'jobId')::uuid from extraction_claim),'55555555-5555-4555-8555-555555555555',(select (data->>'leaseToken')::uuid from extraction_claim)),'stale worker current check denied');
select pg_temp.ex_expect(not pg_temp.ex_complete(),'stale worker completion denied');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','extraction-note','22222222-2222-4222-8222-000000000001',2,'disable');
select pg_temp.ex_expect((select bool_and(status='cancelled' and source_event is null and coverage is null and run is null) from meeting_knowledge.extraction_job),'disable destroys all extraction copies and stored results');
select public.meeting_knowledge_mutate('11111111-1111-4111-8111-111111111111','extraction-note','22222222-2222-4222-8222-000000000001',3,'enable');
select pg_temp.ex_expect(pg_temp.ex_deliver('extraction-note'),'re-enable source ACK creates fresh generation job');
update extraction_claim set data=public.meeting_knowledge_extraction_claim('11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555')->0;
select pg_temp.ex_expect((select data->>'integrationGeneration'='3' from extraction_claim),'new job bound to new integration generation');
delete from public.note where id='extraction-note';
select pg_temp.ex_expect((select bool_and(status='cancelled' and source_event is null and coverage is null and run is null) from meeting_knowledge.extraction_job),'delete permanently destroys every extraction copy');
select pg_temp.ex_expect(not pg_temp.ex_complete(),'deleted source cannot publish units');
reset role;
select count(*) as passed_extraction_checks from extraction_checks;
rollback;
