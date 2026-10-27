# S10 migration 적용 전후 점검

대상 파일은 `supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql`이다(DEC-0022).
에이전트는 migration을 적용하지 않는다.
Andrew가 Supabase SQL Editor에서 아래 순서로 실행한다.

## 적용 순서와 호환성

- migration을 먼저 적용하고, 그 뒤 S10 코드를 배포한다.
- 현재 배포된 코드(S10 이전)는 migration이 적용돼도 그대로 동작한다.
  새 열은 모두 상수 기본값이 있고, 기존 열, index, policy는 바뀌지 않는다.
- S10 코드가 migration보다 먼저 배포되면 RPC나 열이 없다는 오류(PGRST202, 42883, 42703)를 보고 S10 이전 동작으로 내려간다.
  이때는 재시작으로 끊긴 작업이 지금처럼 실패 처리되고 사용자가 다시 시도해야 한다.
- 적용은 짧은 잠금만 건다(상수 기본값 열 추가와 작은 partial index).
  진행 중 작업이 있어도 안전하지만, 가능하면 진행 중 작업이 없을 때 적용한다.

## 1. 적용 전 점검 (읽기 전용)

```sql
-- 1-1. 현재 열. S10 열(lease_owner 등)이 없어야 정상이다(부분 적용 흔적 확인).
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'workflow_job'
order by ordinal_position;

-- 1-2. S10 RPC가 아직 없어야 한다(0행). 시그니처까지 보여 주므로 옛 overload가 남아 있으면 여기서 드러난다.
select p.oid::regprocedure
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname like 'workflow\_job\_%';

-- 1-3. RLS와 정책 기준선. relrowsecurity = true, 정책은 workflow_job_service_role_all 하나.
select relrowsecurity from pg_class where oid = 'public.workflow_job'::regclass;
select polname, polroles::regrole[] as roles, polcmd
from pg_policy where polrelid = 'public.workflow_job'::regclass;

-- 1-4. 기존 partial unique index가 있는지(S10은 이것을 바꾸지 않는다).
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'workflow_job';

-- 1-5. 지금 진행 중인 작업(적용 시점 판단용).
select status, count(*) as jobs, max(updated_at) as last_heartbeat
from public.workflow_job
where status in ('queued', 'processing')
group by status;

-- 1-6. RPC가 기대하는 기존 열 타입. 순서대로 text, text, text, text, jsonb, timestamptz여야 한다
-- (user_id, note_id, status, stage, request, updated_at). 다르면 적용하지 말고 멈춘다.
select column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'public' and table_name = 'workflow_job'
  and column_name in ('user_id', 'note_id', 'status', 'stage', 'request', 'updated_at')
order by array_position(array['user_id', 'note_id', 'status', 'stage', 'request', 'updated_at'], column_name::text);

-- 1-6b. note.id와 note.user_id 타입. 둘 다 text여야 한다(인수 RPC가 note.id = workflow_job.note_id로 비교한다).
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'note' and column_name in ('id', 'user_id');

-- 1-7. service_role이 RLS를 우회하는지(true여야 한다; RPC는 security invoker로 service_role 권한을 쓴다).
select rolname, rolbypassrls from pg_roles where rolname = 'service_role';

-- 1-8. 기존 제약(S10이 추가하는 workflow_job_s10_state_check는 아직 없어야 한다).
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.workflow_job'::regclass
order by conname;

-- 1-9. 상태별 행 수와 가장 큰 request 크기(bytes). 큰 request는 재개 시 별도 읽기(120초 제한)로만 가져온다.
select status, count(*) as jobs, max(pg_column_size(request)) as max_request_bytes
from public.workflow_job
group by status;
```

1-2는 0행이어야 한다(`workflow\_job\_%` 함수가 하나도 없음).

## 2. 적용

`supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql` 전체를 SQL Editor에 붙여 넣고 실행한다.
파일은 `begin ... commit`으로 감싸져 있고 다시 실행해도 같은 결과가 된다(멱등).
마지막 줄의 `notify pgrst, 'reload schema'`가 PostgREST에 새 열과 RPC를 알린다.

## 3. 적용 후 점검 (읽기 전용, 마지막 블록만 rollback으로 끝나는 시험 호출)

```sql
-- 3-1. 새 열 8개와 기본값.
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'workflow_job'
  and column_name in ('lease_owner', 'lease_expires_at', 'execution_generation', 'attempt_count', 'claim_count',
                      'assembly_transcript_id', 'transcript_submission_state', 'transcript_submission_count')
order by column_name;

-- 3-2. 기존 행이 모두 기본값을 받았는지(defaulted = total).
select count(*) filter (where execution_generation = 0 and attempt_count = 0 and claim_count = 0
                          and transcript_submission_state = 'none'
                          and transcript_submission_count = 0
                          and lease_owner is null and lease_expires_at is null) as defaulted,
       count(*) as total
from public.workflow_job;

-- 3-3. RPC 6개와 실행 권한: anon과 authenticated는 false, service_role은 true.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role,
       p.prosecdef as security_definer
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname like 'workflow_job\_%'
order by p.proname;

-- 3-4. RLS와 정책이 그대로인지(1-3과 같은 결과).
select relrowsecurity from pg_class where oid = 'public.workflow_job'::regclass;
select polname, polroles::regrole[] as roles, polcmd
from pg_policy where polrelid = 'public.workflow_job'::regclass;

-- 3-5. 제약과 새 index.
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.workflow_job'::regclass and conname = 'workflow_job_s10_state_check';
select indexname from pg_indexes
where schemaname = 'public' and tablename = 'workflow_job' and indexname = 'workflow_job_active_lease_idx';

-- 3-6. 새 RPC의 ACL과 설정. 기대값:
--   proacl에 PUBLIC(=X/...), anon, authenticated 항목이 없고 service_role=X 와 소유자만 있다;
--   proconfig = {search_path=""}; prosecdef = false(security invoker).
select p.proname, p.proacl, p.proconfig, p.prosecdef
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname like 'workflow\_job\_%'
order by p.proname;

-- 3-7. 없는 job id로 인수를 시험한다. 0행이어야 하고 rollback으로 끝나므로 아무것도 바뀌지 않는다.
begin;
select * from public.workflow_job_claim('00000000-0000-0000-0000-000000000000', 'post-check', 'recover', 300, 300, 3, 10, 'en', 'ko');
select public.workflow_job_load_request('00000000-0000-0000-0000-000000000000', 'post-check', 1);
select public.workflow_job_write('00000000-0000-0000-0000-000000000000', 'post-check', 1, '{"stage":"post-check"}'::jsonb);
-- 아래 둘은 null과 false가 기대값이다.
select public.workflow_job_begin_execution('00000000-0000-0000-0000-000000000000', 'post-check', 1, 3);
select public.workflow_job_renew_lease('00000000-0000-0000-0000-000000000000', 'post-check', 1, 300);
rollback;
```

## 4. 배포 후 확인

- 배포 직후 로그에 `Could not ... workflow_job_claim` 같은 RPC 오류가 없는지 본다.
- 웹 업로드 1건을 요약까지 끝낸 뒤 다음을 확인한다.

```sql
select id, status, execution_generation, attempt_count, claim_count, lease_owner is not null as leased,
       assembly_transcript_id is not null as has_transcript_id,
       transcript_submission_state, transcript_submission_count
from public.workflow_job
order by created_at desc
limit 5;
```

기대값은 `completed`, generation 1, attempt 1, claim 1, leased true, has_transcript_id true, `submitted`, count 1이다(transcript checkpoint를 재사용한 재시도는 id 없이 `none`, 0).

## 5. 배포 뒤 며칠 동안의 모니터링 (읽기 전용)

하루에 한두 번 실행한다.
`expired = true`인 행이 sweep 한두 주기(2~7분) 넘게 남아 있거나, attempt_count나 claim_count가 상한(3, 10)에 가까운 행이 반복해서 보이면 로그와 함께 살펴본다.

```sql
-- 5-1. 진행 중 작업의 실행권 상태.
select id, status, stage, attempt_count, claim_count, execution_generation,
       lease_owner, lease_expires_at, lease_expires_at < now() as expired,
       transcript_submission_state, transcript_submission_count, updated_at
from public.workflow_job
where status in ('queued', 'processing')
order by updated_at;

-- 5-2. 반복 중단으로 멈춘 작업(SQL 상한이 failed로 바꾼 행).
select id, note_id, attempt_count, claim_count, error, updated_at
from public.workflow_job
where status = 'failed' and claim_count > 1 and updated_at > now() - interval '7 days'
order by updated_at desc;

-- 5-3. 최근 재제출 기록(비용 0과 표식, 같은 note의 transcription 행 duration으로 비용을 계산한다).
select u.created_at, u.note_id, u.usage_metadata ->> 'reason' as reason,
       u.usage_metadata ->> 'jobId' as job_id, u.usage_metadata ->> 'attempt' as attempt
from public.workflow_usage u
where u.stage = 'transcription-resubmission' and u.created_at > now() - interval '7 days'
order by u.created_at desc;

-- 5-4. 실행권을 잃은 실행이 기록한 전사(supersededExecution: 저장되지 않은 별도 과금,
--      leaseLostIdSaved: 저장된 id라 새 owner와 같은 전사일 수 있음).
select created_at, note_id, usage_metadata ->> 'transcriptId' as transcript_id,
       usage_metadata ? 'supersededExecution' as superseded, usage_metadata ? 'leaseLostIdSaved' as lease_lost_id_saved
from public.workflow_usage
where stage = 'transcription'
  and (usage_metadata ? 'supersededExecution' or usage_metadata ? 'leaseLostIdSaved')
  and created_at > now() - interval '7 days'
order by created_at desc;

-- 5-5. 같은 transcript id로 transcription 행이 둘 이상인 경우(거의 동시에 기록한 드문 중복).
-- 비용을 합산할 때는 transcript id별로 한 행만 센다.
select usage_metadata ->> 'transcriptId' as transcript_id, count(*) as rows, sum(estimated_cost_usd) as summed_cost
from public.workflow_usage
where stage = 'transcription' and provider = 'assemblyai' and created_at > now() - interval '7 days'
group by 1
having count(*) > 1;

-- 5-6. N1 회귀 감지: note가 저장됐는데 failed로 끝난 작업(0행이어야 한다).
select j.id, j.note_id, j.attempt_count, j.claim_count, j.error, j.updated_at
from public.workflow_job j
where j.status = 'failed' and j.claim_count > 1 and j.updated_at > now() - interval '7 days'
  and exists (select 1 from public.note n where n.id = j.note_id and (n.user_id is null or n.user_id = j.user_id))
order by j.updated_at desc;
```

5-5와 5-6은 0행이 정상이다.
note 조회가 계속 실패하면 note가 있는 작업은 상한으로 끝나지 않고 lease 주기(5분)마다 다시 인수된다(5-1에서 claim_count가 계속 오르는 행으로 보인다).

## 6. 되돌리기

먼저 S10 이전 코드로 되돌리거나 S10 코드를 그대로 둔다(RPC가 없어지면 S10 이전 동작으로 내려간다).
열을 지우면 진행 중 작업의 저장된 전사 id가 사라지므로 그 작업은 복구 시 다시 제출된다.
**되돌리기는 진행 중 작업이 0건일 때만 실행한다.**
아래 쿼리가 0을 돌려줄 때까지 기다린다(배포 직후라면 sweep 한 주기, 약 2분 뒤 다시 확인).

```sql
select count(*) as active_jobs
from public.workflow_job
where status in ('queued', 'processing');
```

S10 코드가 배포된 채로 되돌리면, 실행 중이던 작업은 heartbeat와 상태 쓰기를 S10 이전 방식(id 기준, updated_at 갱신)으로 바꿔 이어간다.

```sql
begin;
drop function if exists public.workflow_job_begin_transcript_submission(uuid, text, integer);
drop function if exists public.workflow_job_write(uuid, text, integer, jsonb);
drop function if exists public.workflow_job_renew_lease(uuid, text, integer, integer);
drop function if exists public.workflow_job_begin_execution(uuid, text, integer, integer);
drop function if exists public.workflow_job_load_request(uuid, text, integer);
drop function if exists public.workflow_job_claim(uuid, text, text, integer, integer, integer, integer, text, text);
drop index if exists public.workflow_job_active_lease_idx;
alter table public.workflow_job drop constraint if exists workflow_job_s10_state_check;
alter table public.workflow_job
  drop column if exists transcript_submission_count,
  drop column if exists transcript_submission_state,
  drop column if exists assembly_transcript_id,
  drop column if exists claim_count,
  drop column if exists attempt_count,
  drop column if exists execution_generation,
  drop column if exists lease_expires_at,
  drop column if exists lease_owner;
commit;
notify pgrst, 'reload schema';
```
