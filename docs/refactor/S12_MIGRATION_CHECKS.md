# S12 마이그레이션 점검과 되돌리기

Andrew가 SQL Editor에서 적용한다.
에이전트는 운영 DB에 접속하거나 이 SQL을 적용하지 않는다.
대상 파일은 `supabase/migrations/20261029180000_workflow_job_s12_shutdown.sql`이다.
S10 마이그레이션이 이미 적용된 DB가 전제다.

## 배포 순서와 판정

1. 테스터가 녹음이나 요약을 시작하지 않는 배포 시간을 Andrew가 정한다.
2. 아래 PRE 쿼리 하나를 실행하고 한 결과에서 모든 항목을 확인한다.
3. missing_columns가 빈 배열이고 active_jobs와 recent_completed가 모두 0일 때만 진행한다.
4. active_null_or_foreign_note_owners가 0이 아니면 자동 수정하지 않고 소유권 확인을 위해 배포를 보류한다.
5. Andrew가 마이그레이션 파일 전체를 SQL Editor에서 적용한다.
6. POST 쿼리 하나를 실행하고 schema_ok, functions_ok, grants_ok, strict_note_ownership이 모두 true인지 확인한다.
7. CI와 리뷰 후 Andrew가 서버 PR을 머지하고 Render 배포의 `/version`을 확인한다.
8. `/ready`가 200인지 확인하고 실제 작업 한 건과 30분을 관찰한다.

최근 30분 completed 확인은 메모리 후처리가 아직 실행 중일 수 있는 배포 전 코드를 보호하기 위한 보수적인 배포 조건이다.
점검은 개수와 스키마만 반환하며 request, result, 녹음 주소, 토큰, 사용자 식별자를 조회 결과에 포함하지 않는다.
PRE나 POST가 오류를 내거나 조건에 맞지 않으면 진행하지 않는다.

## PRE

SQL Editor가 마지막 결과만 보여 주므로 아래 전체가 단일 쿼리다.

```sql
with required(table_name, column_name) as (
  values
    ('workflow_job','lease_owner'),('workflow_job','lease_expires_at'),
    ('workflow_job','execution_generation'),('workflow_job','request'),('workflow_job','result'),
    ('note','id'),('note','user_id'),('note','user_name'),('note','transcription'),
    ('note','transcription_language'),('note','transcription_translations'),('note','summary'),
    ('note','summary_translations'),('note','audio_file'),('note','name'),('note','tags'),
    ('note','diarization'),('note','diarization_translations'),('note','meeting_at'),
    ('note','audio_file_id'),('note','duration_seconds'),
    ('user_memory','user_id'),('user_memory','memory'),('user_memory','processed_note_ids'),
    ('user_memory','updated_at'),('note_insight','note_id'),('note_insight','user_id'),
    ('note_insight','actions'),('note_insight','decisions'),('note_insight','events'),
    ('note_insight','topics'),('note_insight','people'),('note_insight','companies'),
    ('note_insight','source_model'),('note_insight','updated_at')
), missing as (
  select r.* from required r
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name
  )
)
select jsonb_build_object(
  'missing_columns',coalesce((select jsonb_agg(table_name||'.'||column_name) from missing),'[]'::jsonb),
  'active_jobs',(select count(*) from public.workflow_job where status in ('queued','processing')),
  'recent_completed',(select count(*) from public.workflow_job
    where status='completed' and updated_at > now()-interval '30 minutes'),
  'active_null_or_foreign_note_owners',(select count(*) from public.workflow_job j
    join public.note n on n.id=j.note_id
    where j.status in ('queued','processing') and n.user_id is distinct from j.user_id)
) as s12_pre;
```

## POST

아래 전체도 단일 쿼리다.
functions_ok는 필요한 함수가 네 개 모두 있는지 확인한다.
grants_ok는 네 함수 모두 service_role만 실행할 수 있는지 확인한다.

```sql
with expected(signature) as (
  values
    ('public.workflow_job_release(uuid,text,integer)'),
    ('public.workflow_job_persist_note(uuid,text,integer,jsonb,text)'),
    ('public.workflow_job_write_enrichment(uuid,text,integer,text,jsonb)'),
    ('public.workflow_job_postprocessing_done(uuid,text,integer)')
), functions as (
  select signature,to_regprocedure(signature)::oid as oid from expected
)
select jsonb_build_object(
  'schema_ok',exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='workflow_job' and column_name='postprocessing_status'
      and is_nullable='NO'),
  'functions_ok',(select count(*)=4 and bool_and(oid is not null) from functions),
  'grants_ok',(select bool_and(coalesce(
    has_function_privilege('service_role',oid,'EXECUTE')
    and not has_function_privilege('anon',oid,'EXECUTE')
    and not has_function_privilege('authenticated',oid,'EXECUTE')
    and not (select p.prosecdef from pg_proc p where p.oid=functions.oid),false)) from functions),
  'strict_note_ownership',position('n.user_id is null' in pg_get_functiondef(
    'public.workflow_job_claim(uuid,text,text,integer,integer,integer,integer,text,text)'::regprocedure))=0,
  'pending_enrichment',(select count(*) from public.workflow_job where postprocessing_status='pending'),
  'invalid_postprocessing_states',(select count(*) from public.workflow_job
    where postprocessing_status not in ('none','pending','done')),
  'active_jobs',(select count(*) from public.workflow_job where status in ('queued','processing'))
) as s12_post;
```

## 종료와 복구 계약

Andrew가 2026-10-29에 Render의 실제 종료 유예가 30초 이상임을 확인했다.
서버 내부 종료 상한은 20초다.
SIGTERM을 받으면 먼저 draining으로 바꾸고 새 쓰기를 503과 Retry-After: 5로 거부한다.
`GET /ready`는 평소 200, 종료 중 503이며 기존 health와 작업 상태 조회 및 OPTIONS는 유지한다.
응답 본문은 `{"error":"Server is shutting down. Please retry.","code":"SERVER_DRAINING","retryable":true}`다.
종료 시 sweep과 worker 및 heartbeat를 멈추고 실행 중인 외부 호출을 취소한 뒤 조건부로 실행권을 반납한다.
DB 응답이 불명확하거나 SIGKILL을 받으면 S10의 영속 lease 만료와 generation으로 복구한다.
취소는 공급자가 이미 접수한 처리나 DB 트랜잭션의 취소를 보장하지 않는다.
저장된 AssemblyAI id, 제출 상태, request, result와 checkpoint를 보존한다.
completed를 유지하고 미완료 후처리는 postprocessing_status=pending과 기존 request/result로 재실행 출처를 남긴다.
Andrew의 2026-10-29 결정에 따라 completed 후처리의 자동 재개는 다음 PR로 남긴다.
이번 PR의 sweep은 completed를 다시 인수하지 않는다.
기존 completed 행은 none이 되며 이번 마이그레이션은 과거 후처리를 다시 실행하지 않는다.

## 되돌리기

서버 코드만 revert하고 이전 버전을 다시 배포한다.
추가한 열과 함수는 남겨 두고 진행 중인 lease와 request 및 결과를 삭제하지 않는다.
이전 서버의 completed 저장에도 pending이 남을 수 있지만 이번 sweep은 해당 후처리를 자동 재개하지 않는다.
이번 마이그레이션을 되돌리려고 적용된 S10 열이나 함수를 삭제하지 않는다.
저장된 note와 녹음 및 권한이나 공유 상태를 되돌리지 않는다.
