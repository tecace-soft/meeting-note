---
id: DEC-0022
date: 2026-10-26
status: active
question: 백엔드 재시작이나 정지로 끊긴 진행 중 녹음 작업을 실패 처리할 것인가, 자동으로 이어갈 것인가(S10)
options:
  - (a) 전용 스키마(lease, 실행 세대, 시도 횟수, AssemblyAI 전사 id, 제출 상태)와 조건부 인수 RPC를 먼저 추가하고 그 위에서 자동 재개
  - (b) S10 상태를 workflow_job.request jsonb 안에 저장하고 자동 재개
  - (c) 현행 유지(orphan sweep이 오래된 작업을 실패 처리, 사용자가 재시도)
chosen: (a). migration PR로 workflow_job에 S10 열과 조건부 인수 RPC를 추가하고(S10 상태를 request jsonb에 넣지 않는다), 부팅 시와 주기 sweep은 lease가 만료된 작업을 실패 대신 인수해 이어간다. 제출이 AssemblyAI에 접수된 뒤 전사 id 저장 전에 죽은 작업은 복구 시 재제출하고(녹음을 잃지 않는다), 중복 제출은 비용 추적이 되도록 기록한다. 배포 중 중단 시간은 허용하지만 진행 중 녹음을 잃는 것은 허용하지 않는다. 실행 횟수(3회)와 인수 횟수(10회) 상한은 인수 RPC가 SQL에서 적용하고, 상한을 넘은 작업은 같은 문장에서 failed로 끝낸다(응답을 잃어도 끝난다). 인수는 저장된 request를 돌려주지 않고, 재개할 때만 fence된 별도 읽기로 가져온다. 경합 검증은 고정 버전 PGlite harness(A17)와 CI로 한다. 배포는 여전히 테스터가 한가한 시간에 하고, 백엔드를 그에 의존하는 프런트보다 먼저 배포한다.
reason: 무료 플랜 유지(Q12)로 재시작과 정지가 잦고 Q10(작업을 잃지 않음)으로 S10이 필수가 됐다. 부분 unique index만으로는 같은 job 행의 이중 실행을 막지 못하므로 원자적 인수, lease, 실행 세대가 필요하다. request jsonb에 상태를 넣으면 조건부 갱신과 검사가 어렵고 큰 첨부와 섞인다. 재제출 보류는 녹음을 잃을 위험이 있어 비용 기록을 조건으로 재제출을 택했다. 2026-10-26 Andrew 결정 4건.
paths:
  - supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql
  - docs/refactor/S10_MIGRATION_CHECKS.md
  - supabase/tests/workflow_job_fixture_schema.sql
  - workflow-server/src/jobs/lease.ts
  - workflow-server/src/job-lease-sql.test.ts
  - workflow-server/src/jobs/store.ts
  - workflow-server/src/jobs/runner.ts
  - workflow-server/src/jobs/orphanSweep.ts
  - workflow-server/src/routes/jobs.ts
  - workflow-server/src/pipeline/transcription.ts
  - workflow-server/src/pipeline/summarize.ts
  - workflow-server/src/pipeline/usage.ts
  - workflow-server/src/index.ts
supersedes:
  - DEC-0003
source: 2026-10-26 Andrew 결정(S10 접근 (a), PGlite harness A17 승인, 결과 불명 제출은 재제출 후 기록, 배포 중 중단은 허용하되 녹음 손실은 불허), docs/refactor/S10_JOB_RECOVERY_DESIGN.md, docs/refactor/REFACTOR_PLAN.md 4.2 S10
---
## 맥락

S10 설계 메모는 결과 불명 제출의 자동 재제출을 보류하자고 제안했지만 Andrew가 재제출과 기록으로 정했다.
재제출 기록은 workflow_usage의 별도 행과 최종 전사 사용량 행의 표식으로 남는다.
migration은 additive이며 적용 전 배포된 코드는 현행 동작(실패 처리)으로 내려간다.
S12(SIGTERM 처리, 503)와 동시 실행 상한은 이 결정에 들어 있지 않다.
