---
id: DEC-0003
date: 2026-07-23
status: superseded
question: 배포 시 백엔드 재시작으로 끊기는 진행 중 작업을 어떻게 다룰 것인가
options:
  - 재시작 후 아무 처리 안 함(작업이 영구히 멈춘 채 남음)
  - 부팅 시와 주기적으로 오래된 작업을 실패 처리하는 orphan sweep
chosen: orphan sweep(failOrphanedJobs)으로 오래된 작업을 실패 처리하고, 배포는 테스터가 한가한 시간에 하며 백엔드를 이에 의존하는 프런트보다 먼저 배포한다.
reason: 배포는 백엔드를 재시작하고 과거에 진행 중 작업을 방치시킨 이력이 있다.
paths:
  - workflow-server/src/ops/incidents.ts
  - workflow-server/src/jobs/store.ts
  - workflow-server/src/index.ts
  - workflow-server/src/pipeline/summarize.ts
  - workflow-server/src/jobs/runner.ts
  - workflow-server/src/jobs/orphanSweep.ts
  - workflow-server/src/routes/jobs.ts
supersedes: []
source: AGENTS.md "Deploys restart the backend" (최초 추가 커밋 5c44c39, 2026-07-23)
---
## 맥락

index.ts는 크지만 failOrphanedJobs와 작업 소유 표식이 이 파일에 있다.
작업 상태 처리 코드를 바꿀 때 sweep 동작이 유지되는지 확인한다.
