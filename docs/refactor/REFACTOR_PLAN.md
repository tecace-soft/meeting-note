# Meeting Note 리팩터링 계획 (정본, 2026-10-21)

이 문서는 #14 리팩터링의 단일 정본이다.
아래 네 문서를 합치고 오래된 내용을 고친 결과이며, 그 문서들은 이력으로만 남긴다.
- docs/reviews/2026-10-09-renovation-review.md
- docs/reviews/2026-10-09-strangler-plan.md
- docs/reviews/2026-10-09-manual-deploy-steps.md
- docs/handoffs/2026-10-20-refactor-handoff.md

읽는 사람: 이 계획을 검토하는 Codex(회사 SSH 서버, 새 clone, 이전 세션 기억 없음)와 Andrew.
구현은 검토 피드백을 반영한 뒤 Andrew의 Claude Code 세션에서 한다.
Codex는 코드를 수정하지 않고 마지막 절 "Codex 검토 요청"의 형식으로 피드백만 준다.

## 1. 목적과 결론

- 목적: 안정성을 해치지 않고 백엔드 god-file과 웹 데이터 접근을 작고 검증 가능한 모듈로 나눠, 이후 기능 추가와 장애 대응을 쉽게 만든다.
- 2026-10-19 회의(Hansoo, Andrew) 방향: 안정성 우선, 필요하면 재설계, 자동화 최대화.
- 2026-10-09 전체 리뷰(Claude 4개 관점 + Codex) 결론: 전면 재작성은 정당화되지 않고 점진적 strangler 리팩터링이 맞다.
- 근거: 최신 서브시스템(knowledge, mcp)은 이미 모듈화되어 한 줄 dispatch로 붙어 있고, 신뢰성 처리(heartbeat, orphan sweep, 멱등성, 재시도)가 이미 코드에 쌓여 있어 재작성은 고친 장애를 다시 드러낸다.
- 권장 기준안: strangler(경로 단위 추출, 단계마다 배포 가능, 동작 보존).
- 이 기준안은 DEC-0021(docs/decisions/0021-refactor-incremental-strangler.md)로 기록했다.
- Hansoo의 최종 승인은 아직 없다.
- AGENTS.md 규칙대로 우리 쪽을 막지 않는 외부 질문은 권장 기본값으로 진행하고, 뒤집히면 대체 결정을 기록한다.

## 2. 현재 상태 (2026-10-21 검증)

- HEAD: d780d73 (main, origin/main과 동기화).
- 라이브 백엔드 /version: 358bcaa이며, 358bcaa 이후 workflow-server 변경이 없어 HEAD 코드와 같다.
- 라이브 프런트 /version.json: d780d73.
- /health: msTenantGate=enforced, msClientGate=log-only.
- `workflow-server/src/index.ts`: 3,995줄, 최상위 함수 104개.
- 크기 추이: 3,593(1e590d5, 리뷰 기준) -> 3,824(20d7025) -> 4,012(e7d3c55) -> 3,995(HEAD).
- 즉 리뷰 후 12일 동안 402줄이 늘었고, 새 기능이 계속 index.ts에 쌓인다.
- 백엔드 테스트: `npm test` 570개 통과(리뷰 당시 529).
- 프런트 테스트: `npx vitest run` 11개 파일, 99개 통과.
- CI(.github/workflows/ci.yml): backend build+test, frontend build+vitest, lint(`--max-warnings 0`) 세 job 모두 차단형이다.
- 10/09 tracker의 "lint gate deferred"는 오래된 내용이며 5991d03에서 차단형이 되었다.
- `src/data/`, `workflow-server/src/routes/`, `src/http/` 등 계획된 모듈은 아직 없다.

### 2.1 완료 항목

| 항목 | 내용 | 커밋 | 상태 |
| --- | --- | --- | --- |
| 1 | meeting-recordings 버킷 RLS를 owner_id로 범위 지정 | 520f81a, 9c2a112 | 완료, prod 적용 |
| A | 녹음 잘림/무음 누락 수정 | bf57199 | 완료 |
| A | 멱등 note 쓰기, orphan 수렴, transcript checkpoint | 20d7025 | 완료, migration 적용 |
| A | 웹 재시도 시 noteId 재사용 | 4b65e62 | 완료 |
| B | Codex-only #2/#3/#4 (프로젝트 채팅, 메모리 fold, insight 소유) | 52c97b9 | 완료, 2-user E2E는 선택 과제로 남음 |
| B | #10 edge Graph fallback 조직 allowlist | 8d9789c | 완료, 배포 |
| 형제 취약점 | admin-*, mcp-token, note-audio-url Graph 경로 | 86175a9 | 완료, 배포 |
| C | 모바일 중단 m4a 삭제 방지 | a6095a5 | 완료, 실기기 E2E 통과(2026-10-12, Andrew 기록) |
| C | Vitest + 차단형 CI | a666950 | 완료 (= T2-0) |
| C | lint 0 problems + 차단형 lint gate | 5991d03 | 완료 |
| C | Gemini 공통 helper(isRetryableGeminiError, dedupeModels) | e582bfa | 완료 |
| C | mcp_tracking migration 정리 | 40a959c | 완료, 적용 |
| R01 | note-audio-url 소유권 게이트 | 52c292c, cbd9e22 | 완료, 백필 후 레거시 미재생 319 -> 0 |
| 후속 | 노트가 참조하는 최근 녹음 삭제 차단 | 4436643 | 완료, prod E2E 통과 |
| 후속 | 인증 provider clear 시 anon 요청 방지 | 3f9b5bd | 완료 (R09 일부) |
| 후속 | 로그인 신뢰를 tid+oid로 한정 | af6635d | 완료 (DEC-0001) |

- manual-deploy-steps의 단계 1~3은 완료, 단계 4(모바일 E2E)는 2026-10-12 통과, 단계 5(Group B 2-user E2E)는 열려 있다.
- 그 문서의 "웹 삭제 가드 미커밋"은 오래된 내용이며 4436643으로 출시되었다.

### 2.2 10/09 이후 새로 생긴 코드 (목표 구조에 반영)

- `workflow-server/src/microsoftIdentity.ts` (af6635d): 신원 확인의 단일 구현, index.ts의 getMicrosoftProfile은 얇은 위임이다.
- `workflow-server/src/issues.ts` (e7d3c55): 이슈 순수 로직, 라우트(issueResolution, issueNotify)는 아직 index.ts에 있다.
- `workflow-server/src/knowledge/enable-all.ts` (e597609): knowledge/http.ts가 소유하며 index.ts와 무관하다.
- `workflow-server/src/productDocs.ts` (25a7272): 로더는 모듈이고 라우트 2개는 index.ts:706-744에 있다.
- `docs/decisions/` (00fcdb6): DEC-0001..0020, 이 계획으로 DEC-0021 추가.
- `NoSpeechDetectedError` (1a3696b): index.ts:144.

## 3. 범위와 먼저 확인할 질문

구현 세션의 첫 단계는 기준안으로 Andrew와 범위를 확정하는 것이다(requirements-clarification 규칙, 선택지 질문).

1. 웹 데이터 계층(T2)을 1단계에 포함할까?
   - (a) 포함: T2-1을 첫 배치에 넣는다 (권장, Project.tsx 무음 성공 버그를 함께 고친다).
   - (b) 백엔드(T1)만 먼저 하고 T2는 나중에.
2. 모바일(Flutter)은 범위인가?
   - (a) 제외 (권장, C1 iOS 스캐폴드가 recording_service.dart에 미커밋으로 있어 충돌 위험).
   - (b) 모바일 data layer(T5, NotesRepository 분리)까지 포함.
3. P1.1 AssemblyAI webhook 전환은 범위인가?
   - (a) 제외하고 후보로 유지 (권장, OPS_BACKLOG에서 ON HOLD이고 재설계라 strangler와 섞으면 위험).
   - (b) T1 완료 후 별도 결정으로 착수.
   - (c) 지금 우선 착수.
4. Hansoo가 말한 "필요하면 재설계"는 어느 영역인가?
   - (a) 특정 영역 없음, 안정성 핫스팟 우선이면 충분.
   - (b) 작업 실행 모델(프로세스 내 작업 큐, P1.1과 연결).
   - (c) 화면/UX.
   - (d) Andrew가 Hansoo에게 확인 후 답.
5. 열린 후보(R08, R09, R10, R12)를 리팩터링 중에 끼워 넣을까?
   - (a) 관련 코드를 옮긴 직후 별도 동작 변경 커밋으로 처리 (권장).
   - (b) 리팩터링이 끝난 뒤 따로.
6. Render 자동 배포를 "CI 통과 후"로 바꿀 수 있나? (대시보드 설정, 소유자는 Hansoo)
   - (a) 바꾼다.
   - (b) 그대로 두고 push 전 로컬 전체 검증으로 대신한다.

## 4. 목표 구조

기존 패턴을 따른다: 백엔드는 `handle<Group>Request(req, res, url) => Promise<boolean>` 한 줄 dispatch(knowledge, mcp가 이미 사용), 웹은 `src/lib/<domain>/`(src/lib/issues/가 선례).

```
workflow-server/src/
  index.ts              부트스트랩만 (파일명 유지: start = node build/index.js)
  config/loadEnv.ts     dotenv 로드 (가장 먼저 import되는 side-effect 모듈)
  config/env.ts         env 객체
  db/supabaseClient.ts  service-role client 1개
  http/shared.ts        HttpError, sendJson, sendNoContent, readBody, corsHeaders, getHttpStatus, errorMessage, getBearerToken
  http/identity.ts      getMicrosoftUserId, getMicrosoftProfile (microsoftIdentity.ts 위임)
  http/router.ts        dispatch 순서와 404 (최종 단계)
  ai/geminiFallback.ts  callGeminiWithFallback, delay
  pipeline/usage.ts     recordGeminiUsage, recordAssemblyUsage
  pipeline/promptLoaders.ts  loadSummaryPrompt, resolveSummaryPromptForAndroid, resolveRegenerateSummaryRules
  pipeline/transcription.ts, pipeline/summarize.ts, pipeline/androidUpload.ts
  jobs/queue.ts, jobs/orphanSweep.ts, jobs/checkpoint.ts
  ops/incidents.ts      fileOpsIncident, raiseIncident (순수 helper는 기존 opsAgent.ts)
  routes/transcriptionTest.ts, issues.ts, productDocs.ts, briefing.ts, insight.ts, projectChat.ts, regenerateSummary.ts, jobs.ts
  (기존 유지) knowledge/, mcp/, issues.ts, microsoftIdentity.ts, memory.ts, parsers.ts, prompts.ts, gemini.ts
src/lib/notes/repository.ts     owner 범위 + row-count 확인 note 쓰기
src/lib/speakers/repository.ts  speaker 접근
```

- 모듈 수준 상태(`completedJobResults`, `createdIssueMailSent`, `productDocsIdentityCache`, `warnedRelativeDeepLink`)는 정확히 한 모듈에만 둔다.
- 의존 방향: routes -> pipeline/jobs/ops -> ai/db/http/config, 역방향 import 금지(순환 방지).
- `src/data/`(10/09 계획)는 쓰지 않고 기존 `src/lib/<domain>/` 패턴을 따른다.

## 5. 단계별 계획

공통 규칙: 단계 1개 = 커밋 1개(또는 짧은 PR 1개), 동작 보존, 장기 브랜치 금지, 단계마다 main에 배포 가능해야 한다.
줄 번호는 HEAD d780d73 기준이며 각 단계 시작 시 다시 확인한다.

### 5.1 단계 공통 템플릿

- 목표, 대상 파일, 특성화 테스트(옮기기 전에 먼저 추가), 검증, 롤백, 완료 기준을 단계마다 채운다.
- 검증 기본값: `npm test`(백엔드), `npx tsc --noEmit`, `npm run build`, 라우트 parity 테스트, 로컬 `npm run dev` 후 해당 경로 수동 호출.
- 배포 후: /version의 sha가 새 커밋인지, /health ok, Render 로그에 오류 증가가 없는지, F9 ops 인시던트 메일이 새로 오지 않는지 확인한다.
- 롤백 기본값: `git revert <sha>` 후 push(자동 재배포) 또는 Render 대시보드의 이전 배포 롤백.
- 마이그레이션이 없는 단계만 이 롤백이 즉시 안전하다; 리팩터링 단계는 마이그레이션을 만들지 않는다.
- feature flag는 쓰지 않는다; 동작을 바꾸는 단계(T2-1, 후보 수정)만 별도 커밋으로 분리하고 필요할 때만 flag를 검토한다.

### 5.2 Target 1: workflow-server/src/index.ts

| 단계 | 10/09 번호 | 내용 | 대상 (HEAD 줄) | 크기 |
| --- | --- | --- | --- | --- |
| T1-0a | 신규 | index.ts를 import 가능하게(`server` export, 직접 실행일 때만 listen) + 라우트 parity 테스트 | 3680-3798, 3939-3995 | S |
| T1-0b | T1-0 일부 | env와 dotenv 로드 순서 분리 | 63-64, 275-297, 315-319 | S |
| T1-0c | T1-0 | HTTP primitive, identity 위임, supabase client 이동 | 129-143, 320-403, 681-704 | M |
| T1-0d | 신규 | 공유 AI/usage helper 이동, `parseDiarizedSegmentsWithRecovery` 등 순수 함수는 parsers.ts로 | 807-872, 1191-1257, 1607-1694 | M |
| T1-1 | T1-1 | transcription-test 라우트 + 테스트 전용 엔진 3개 + uploadAssemblyAudio | 577-607, 1506-1606, 1733-1865, 3641-3661 | M |
| T1-2 | T1-2 일부 | issues 라우트 (순수 로직은 기존 issues.ts) | 3153-3390 | M |
| T1-3 | T1-2 일부 | ops 인시던트(fileOpsIncident, raiseIncident) | 3391-3593 | M |
| T1-4 | 신규 | product-docs 라우트 2개 (DEC-0017) | 706-744 | S |
| T1-5 | T1-3 | meeting-briefing | 2981-3089 | S |
| T1-6 | T1-5 | refresh-note-insight, admin/backfill-insight | 3090-3152, 3594-3640 | S |
| T1-7 | T1-4 | project-chat + SSE (Group B #2 수정 2661 보존) | 2569-2788 | M |
| T1-8 | T1-6 | regenerate-summary + prompt loader | 873-935, 2789-2894 | M |
| T1-9 | T1-7 | 작업 큐, checkpoint, orphan sweep (DEC-0003) | 1866-1969, 2283-2568, 3826-3938 | L |
| T1-10 | T1-8 | 파이프라인 3개 하위 단계: androidUpload, transcription, summarize+finalize | 404-532, 936-1190, 1258-1505, 1695-1732, 1970-2282, 2895-2980 | L |
| T1-11 | 신규 | router를 http/router.ts로, index.ts는 부트스트랩만 | 3680-3798 | S |

T1-0a 상세 (모든 단계의 안전망):
- 목표: index.ts가 import 시 listen하지 않게 해서 테스트가 실제 router를 in-process로 띄울 수 있게 한다.
- 방법: `server`를 export하고, `fileURLToPath(import.meta.url)`과 `process.argv[1]`이 같을 때만 기존 `server.listen(env.port, ...)` 블록을 실행한다.
- 테스트(`workflow-server/src/http/routes.parity.test.ts`): `server.listen(0)` 후 외부 I/O 없이 결정되는 응답을 기록한다.
- 기록 대상: if-chain의 18개 경로(`/`와 `/health`를 따로 셈) 각각에 인증 없이 호출한 status, OPTIONS 204, 미등록 경로 404, GET /health의 키 목록, /version 형태.
- 기록 대상: `req.url ===`로 비교하는 경로는 query string이 붙으면 404가 되는 현재 동작(pathname 비교 경로와 다름).
- 기록 대상: dispatch 순서(knowledge가 OPTIONS보다 먼저, MCP는 OPTIONS 다음).
- 기록 대상: `/admin/backfill-insight`는 MCP가 소유하지 않고 if-chain으로 떨어진다는 사실.
- 검증: Render에서 `node build/index.js`로 시작해도 listen하는지 배포 후 /version으로 확인.
- 롤백: revert 1개.
- 완료 기준: parity 테스트가 18개 경로 + 404 + OPTIONS를 덮고 CI에서 통과.

T1-0b 상세:
- 문제: index.ts:64의 `loadDotenv`는 ESM import가 모두 평가된 뒤에 실행된다.
- env를 별도 모듈로 옮기면 그 모듈은 dotenv 로드 전에 평가되어 로컬 개발에서 빈 설정이 된다(prod는 Render가 실제 env를 주므로 드러나지 않음).
- alerts.ts는 이미 같은 이유로 로컬에서 .env 값을 못 읽는다.
- 해결: `config/loadEnv.ts`를 index.ts의 첫 import로 두고 env.ts는 그 뒤에 평가되게 한다.
- 이것은 로컬 동작만 바꾸는 개선이므로 커밋 메시지에 명시한다.
- 테스트: env 기본값 규칙(`||` vs `??`, 빈 문자열 처리) 특성화.

T1-0c 상세:
- `getHttpStatus`(377)는 오류 메시지 부분 문자열로 status를 정한다("Missing bearer token" -> 401, "required" -> 400 등).
- 그래서 코드를 옮길 때 오류 메시지 문구를 한 글자도 바꾸지 않는다.
- 이동 전에 getHttpStatus, errorMessage, corsHeaders, readBody 상한을 특성화 테스트로 고정한다.
- 이후 새 라우트는 index.ts가 아니라 `routes/`에 만든다(정책, 7절).

T1-1..T1-8 공통:
- 옮길 함수를 먼저 export하고 colocated `*.test.ts`(`node:test`, tsx)로 순수 부분을 고정한 뒤 이동한다.
- 모듈은 `handle<Group>Request`를 export하고 router에 한 줄로 연결한다.
- parity 테스트가 그대로 통과해야 한다.
- T1-7은 52c97b9의 `noteAccessFilterFor` 적용(2661)을 테스트로 고정한다(호출자에게 보이는 노트만 모델에 전달).
- T1-8은 52c97b9의 "regenerate의 fold/insight는 요청자가 아니라 note.user_id로" 동작을 테스트로 고정한다.
- T1-4는 제품 문서가 index.ts를 depends_on으로 두므로 7절 제품 문서 규칙을 따른다.

T1-9, T1-10 상세 (가장 위험):
- 10/09의 "진행 중 수정이 merge된 뒤" 조건은 충족됐다(20d7025, 4b65e62).
- 남은 이유는 결합도와 DEC-0003이다.
- 배포는 테스터가 한가한 시간에, 진행 중 작업이 없는지 `workflow_job`의 queued/processing을 읽기 전용으로 확인한 뒤 한다.
- 배포 직후 orphan sweep 로그("Marked N orphaned workflow job(s)")와 실제 요약 1건 E2E(웹 업로드 -> 요약 완료)를 확인한다.
- T1-10은 3개 커밋으로 나누고 각각 웹 업로드 1건과 Android 업로드 1건 E2E를 한다.
- 테스트: heartbeat/stale 판정, reconstructResultFromNote, checkpoint 재사용, insertNote upsert 멱등성을 fake supabase로 특성화.

Target 1 완료 기준:
- index.ts 400줄 이하(부트스트랩: env, server, sweep 타이머, knowledge worker 시작).
- 중간 점검: T1-8 후 약 2,200줄 이하(추정).
- 백엔드 테스트 수는 570 아래로 내려가지 않고, 옮긴 모듈마다 colocated 테스트가 있다.
- parity 테스트 전 단계 통과, CI 3 job 통과.

### 5.3 Target 2: 웹 데이터 계층과 큰 페이지

- 현재: `supabase.from('note')` 21곳(8개 파일), `supabase.from('speaker')` 24곳.
- 페이지 크기: SummaryHistory.tsx 4,090, TranscriptionSummary.tsx 3,283, Project.tsx 1,984, AccountSettings.tsx 1,917.
- 확인된 버그(아직 있음): `src/pages/Project.tsx:724-731`(summary_edit 저장)과 `:755-760`(이름 변경)은 user_id 범위, `.select()`, row 수 확인 없이 성공 처리한다.
- 올바른 선례: `src/pages/SummaryHistory.tsx:1800-1810`(0 row면 오류).

| 단계 | 내용 | 크기 | 비고 |
| --- | --- | --- | --- |
| T2-0 | Vitest + testing-library + jsdom | S | 완료(a666950) |
| T2-1 | `src/lib/notes/repository.ts`에 owner 범위 + row 수 확인 update, Project.tsx 두 곳 이전 | S | 동작 변경(버그 수정): 먼저 E2E 재현 |
| T2-2 | 나머지 note 호출부를 repository로, 파일 1개당 커밋 1개 | M | 동작 보존 |
| T2-3 | `src/lib/speakers/repository.ts` + 24곳 이전 | M | DEC-0008, DEC-0010 확인 |
| T2-4 | SummaryHistory.tsx부터 hook/하위 컴포넌트로 분해 | L | 추출 전 renderHook 테스트 |

- T2-1 재현: 프로젝트를 공유받은 비소유자가 Project 화면에서 노트를 편집/이름 변경했을 때 성공으로 보이는지 2계정으로 확인한다.
- 2계정 재현이 안 되면 mock supabase(0 row 반환) 단위 테스트로 재현을 대신하고 그 사실을 기록한다.
- T2 완료 기준: 페이지에서 `supabase.from('note'|'speaker')` 직접 호출 0곳, repository 테스트 존재, 프런트 테스트 99개 이상 유지.

### 5.4 의존 순서

T1-0a -> T1-0b -> T1-0c -> T1-0d -> (T1-1..T1-8, 서로 독립, 권장 순서는 표 순서) -> T1-9 -> T1-10(a, b, c) -> T1-11.
T2-1은 T1과 독립이며 T2-2 -> T2-3 -> T2-4 순서다.
T1-3(raiseIncident)은 router의 500 처리와 파이프라인이 쓰므로 T1-9, T1-10보다 먼저 한다.

### 5.5 권장 첫 배치

1. T1-0a (import 가능화 + parity 테스트): 이후 모든 단계의 안전망.
2. T2-1 (note repository): 확인된 무음 성공 버그를 가장 작은 변경으로 고친다(범위 질문 1이 (a)일 때).
3. T1-0b, T1-0c (env와 HTTP primitive): 첫 추출 전제.
4. T1-1 (transcription-test): 단일 사용자 게이트라 가장 안전한 첫 추출.

## 6. 열린 후보 항목 (리팩터링 범위 밖, 상태 검증됨)

| 항목 | 상태 (HEAD 기준) | 근거 |
| --- | --- | --- |
| R08 프로젝트 공유 권한 불일치 | 열림 | note-audio-url에 project 분기 없음, `search_notes` 최신 RPC(20260810190000) 64행은 owner/shared_users만 본다 |
| R09 인증 대기 timeout 후 anon 진행 | 일부 해결 | 3f9b5bd로 provider clear 경로는 해결; `src/config/supabaseConfig.ts:74-78`의 15초 후 토큰 없이 진행과 `src/context/AuthContext.tsx:159` 교환 fetch의 deadline 부재는 남음 |
| R10 오디오 서명 URL 만료 무시 | 열림 | `src/pages/SummaryHistory.tsx:508` Map<string,string> 캐시, 1642/1670/1761에서 만료 확인 없이 재사용 |
| R12 관리 UI/문서 불일치 | 열림 | AdminControls.tsx:218-219 모델 선택 vs index.ts:300/1341 universal-2 고정; RUNBOOK.md:36에 삭제된 update-user-memory; RUNBOOK.md:112 "Jobs are safe" |
| P1.1 AssemblyAI webhook | ON HOLD (사용자 결정) | webhook_url 없음, transcribeWithAssembly(1330) 폴링 유지 |
| Group B 2-user prod E2E | 열림(선택) | #4 regenerate 후 note_insight 소유 유지, #2 제3자 노트 비노출 |
| #20 known-client gate | 대기 | 2026-10-26 이후 `ms_token_client_check` 로그 약 7일 검토 후 MS_KNOWN_CLIENT_IDS 설정, MS_TOKEN_REQUIRE_KNOWN_CLIENT=true |
| 범위 밖 보안 후속 | 열림 | 정적 MCP key + x-meeting-note-user-id 헤더로 사용자 선택 가능, edge verifyAppJwt가 exp/role/iss 미확인 |

- 후보를 고칠 때는 해당 코드를 옮긴 단계와 별도 커밋으로, E2E 재현 후 수정한다.
- #20은 SUPABASE_TOKEN_REQUIRE_ID_TOKEN을 끈 채로 둔다(msal_auth에 forceRefresh 없음).

## 7. 지켜야 할 규칙

- 커밋과 푸시는 Andrew가 요청할 때만 한다.
- main push는 web과 backend를 자동 배포한다(백엔드 재시작, DEC-0003): 백엔드를 그에 의존하는 프런트보다 먼저, 테스터가 한가한 시간에 배포한다.
- 명시적 경로만 stage한다(git add -A, git add ., commit -a 금지).
- --no-verify 금지.
- 공유 트리에서 stash, checkout, reset, clean, rebase 금지.
- 커밋 작성자는 andrewyoo_tecace이고 에이전트 이름, Co-Authored-By, 세션 트레일러를 넣지 않는다.
- 커밋 전에 비밀값 검사를 한다; 비밀값은 채팅과 파일에 쓰지 않고 env는 이름만 다룬다.
- 문서와 결정 기록에 tenant id, client id, oid, 이메일을 쓰지 않는다.
- prod DB에는 쓰지 않는다: 마이그레이션은 파일만 만들고 Andrew가 SQL Editor에서 적용하며, PRE/POST check와 ROLLBACK 블록을 포함한다(SQL Editor는 마지막 결과만 보여 준다).
- 버그는 E2E로 재현한 뒤 수정하고 같은 방식으로 검증한다.
- 품질을 우선하고 애매한 결정은 선택지 질문으로 묻는다.
- 파일 변경 전 `npm run decisions:check`를 돌리고, active 결정과 모순되면 먼저 대체 결정을 기록한다.
- 제품 문서 본문을 바꾸면 revision을 올리고 `npm run docs:check`를 돌리며, 서명(docs:verify)은 Andrew 승인 후에 한다.
- Gemini는 lite 모델만(DEC-0005), 중첩 responseSchema 금지(DEC-0006).
- Hansoo(VP, 비즈니스)에게 보내는 메시지는 쉬운 말로 쓴다.
- C1 파일 5개는 건드리지 않는다: C1_M4A_RECOVERY_DESIGN.md, meeting-note-mobile/app/ios/Runner/AppDelegate.swift, AudioMergePlugin.swift, meeting-note-mobile/app/lib/features/record/data/recording_service.dart, audio_merge.dart.
- 문서는 한 문장 한 줄로 쓰고 em-dash를 쓰지 않는다.
- (신규) T1-0a 이후 index.ts에 새 라우트나 새 최상위 함수를 추가하지 않는다; 새 기능은 해당 모듈에 만든다.
- (신규) 리팩터링 커밋과 동작 변경 커밋을 섞지 않는다; 이동 커밋은 오류 문구, 라우트 순서, 응답 형태를 바꾸지 않는다.

## 8. 위험 등록부

| 위험 | 가능성 | 영향 | 완화 |
| --- | --- | --- | --- |
| 배포 재시작으로 진행 중 작업 중단 | 높음 | 중 | DEC-0003 순서와 시간대, 배포 전 활성 작업 확인, 배포 후 sweep 로그 확인 |
| 오류 문구 변경으로 HTTP status가 바뀜(getHttpStatus 부분 문자열) | 중 | 중 | 문구 고정, getHttpStatus 특성화 테스트 |
| 라우트 순서/매칭 차이(req.url vs pathname, knowledge가 OPTIONS보다 먼저) | 중 | 높음 | T1-0a parity 테스트 |
| env 모듈 분리 시 dotenv 로드 순서 붕괴 | 높음(대비 없으면) | 로컬 중 | loadEnv 첫 import, 로컬 스모크 |
| 모듈 수준 상태 중복/분할 | 중 | 중 | 상태별 단일 소유 모듈, 리뷰 체크 |
| 순환 import(raiseIncident를 router와 파이프라인이 사용) | 중 | 중 | 의존 방향 규칙, T1-3을 T1-9 전에 |
| Render가 CI 전에 배포 | 중 | 중 | push 전 로컬 전체 검증, 질문 6 |
| 제품 문서 stale(depends_on에 index.ts) | 높음 | 낮음 | revision 증가, docs:check, Andrew 승인 후 docs:verify |
| 병행 기능 작업과 index.ts 충돌 | 중 | 중 | 새 코드 index.ts 금지 규칙, 작은 단계 |
| Hansoo가 범위를 뒤집음 | 낮음~중 | 중 | 단계마다 독립 가치, 대체 결정 기록 |
| 모바일 C1 스캐폴드 충돌 | 낮음(모바일 제외 시) | 중 | 모바일 범위 제외, recording_service.dart 변경 시 Andrew에게 알림 |

## 9. 완료 정의

- 단계 완료: 특성화 테스트 선행, parity 통과, CI 3 job 통과, decisions:check 확인, 배포 후 /version과 /health 확인, 해당 경로 E2E 1건, 롤백 방법 확인, 이 문서의 상태 표 갱신.
- 전체 완료: 5.2와 5.3의 완료 기준 충족, product docs(architecture.md 등) 구조 설명 갱신과 docs:check 통과, DEC-0021 status 재확인.
- 진행 상태는 이 문서 2.1 표와 각 단계 표에 기록한다(다른 문서에 두지 않는다).

## 10. Gotchas

- Windows CRLF와 LF 차이: 제품 문서 해시는 정규화되지만(358bcaa) 생성 파일은 조심한다; build.gradle.kts의 M 표시는 CRLF 차이뿐이다.
- `.githooks/pre-commit`이 docs/ai-native/history.md를 재생성한다(정상).
- AX-KH node "Meeting Note 현황" 갱신은 수동이고, 커밋 후 `npm run axkh:node:check`는 항상 stale이 된다; 개인 AXKH key가 필요하다.
- 인프라 소유(2026-10-20 검증): 로그인 테넌트는 TecAce 회사 테넌트, 앱 등록 소유자는 Hansoo와 Andrew, Render workspace 소유자는 Hansoo.
- 모바일 APK는 기존 debug key로 서명해야 한다(build_apk.sh fingerprint 검사, DEC-0020); 다른 환경 빌드는 재설치를 강제한다.
- repo 마이그레이션은 자동 적용되지 않고 prod에 drift 이력이 있다; 코드 배포 전 컬럼을 확인한다.
- edge function은 `npx supabase functions deploy <name>`로 수동 배포한다.
- MCP는 `/admin`, `/admin/api/overview`, `/admin/health` 등 특정 경로만 소유하며 `/admin/backfill-insight`는 index.ts if-chain이 처리한다(AGENTS.md의 "/admin/*" 표현보다 좁다).
- DEC-0016은 MCP가 "가장 먼저" dispatch된다고 적지만 실제로는 knowledge(3684) -> OPTIONS -> MCP(3693) 순서다; router 이동 시 이 순서를 유지한다.
- index.ts는 import 시 `process.on('unhandledRejection'|'uncaughtException')`과 undici global dispatcher를 등록한다; 테스트가 import할 때도 등록된다.
- `TRANSCRIPTION_MODEL_TEST_USER_ID`, `INSIGHT_BACKFILL_ADMIN_IDS` 같은 하드코딩 id는 옮기되 값을 문서나 로그에 복사하지 않는다.
- 커버리지 도구는 설치돼 있지 않다; 새 의존성(@vitest/coverage-v8 등)은 Andrew 승인 후에만 추가한다.

## 11. 검증 명령

- Root: `npx vitest run`, `npm run lint`, `npm run build`, `npm run decisions:test`, `npm run decisions:check`, `npm run axkh:node:test`.
- workflow-server: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run docs:check`.
- Mobile(범위일 때만): `flutter test`, `flutter analyze`(기존 info 34건).
- Live: GET https://meeting-note-backend-njfb.onrender.com/health, /version, https://meetingnote.tecace.com/version.json.
- 기준선(2026-10-21): 백엔드 570 통과, 프런트 99 통과(11 파일), lint 0, index.ts 3,995줄.

## 12. Best-practice check

| 관행 | 판정 | 내용 |
| --- | --- | --- |
| 이동 전 특성화 테스트 | Fixed | 10/09 계획은 순수 helper만 다뤘고 index.ts는 import 시 listen해 라우트 테스트가 불가능했다; T1-0a 추가 |
| 작고 독립 배포 가능한 동작 보존 단계 | Fixed | T1-0을 a~d로, issues/ops를 T1-2/T1-3으로 나눔; 단계마다 검증, 롤백, 완료 기준 |
| big-bang 브랜치 금지 | Pass | 단계 1개 = 커밋 1개, main에 순차 배포 |
| 라우트/계약 parity | Fixed | 18개 경로, 404, OPTIONS, dispatch 순서, query string 매칭을 parity 테스트로 고정 |
| 동작 변경에만 feature flag | Pass | 리팩터링은 flag 없음, 동작 변경은 별도 커밋(T2-1, 후보 수정) |
| DEC-0003 배포 재시작 | Fixed | T1-9/T1-10에 활성 작업 확인, 시간대, sweep 로그, E2E 명시 |
| 단계별 관측(로그/health) | Fixed | 배포 후 /version sha, /health, Render 로그, F9 인시던트 확인을 공통 템플릿에 추가 |
| 측정 가능한 종료 기준 | Fixed | index.ts 줄 수, 테스트 수 하한, 모듈별 테스트, 페이지 직접 호출 0곳 |
| 커버리지 측정 | Gap | 커버리지 도구 없음; 모듈별 테스트 존재로 대신하고 도구 추가는 Andrew 결정 |
| 의존 순서 | Fixed | 5.4에 명시, raiseIncident와 공유 AI helper를 선행 단계로 |
| 위험 등록부 | Fixed | 8절 신규 |
| 완료 정의 | Fixed | 9절 신규 |
| 결정 기록 | Fixed | DEC-0021 추가, 단계마다 decisions:check |
| 전략 ADR | Fixed | DEC-0021이 전략 ADR 역할; Hansoo 승인 대기 명시 |
| 성장 억제(새 코드 유입 차단) | Fixed | index.ts 신규 코드 금지 규칙 추가(12일간 +402줄) |
| CI 통과 후 배포 | Gap | Render 자동 배포가 CI와 독립인지 미확인; 질문 6 |
| 기존 패턴 우선 | Fixed | `src/data/` 대신 `src/lib/<domain>/` |

## 13. 참고 문서

- AGENTS.md, RUNBOOK.md, OPS_BACKLOG.md, LOCAL_DEV.md.
- docs/decisions/README.md, DEC-0001, DEC-0003, DEC-0005, DEC-0006, DEC-0016, DEC-0017, DEC-0021.
- workflow-server/content/product-docs/ (architecture.md, data-model-and-security.md 등 12개).
- docs/ai-native/history.md.
- docs/reviews/2026-09-29-ops-stability-review.md (R08~R12 원문).
- 이력(대체됨): docs/reviews/2026-10-09-renovation-review.md, docs/reviews/2026-10-09-strangler-plan.md, docs/reviews/2026-10-09-manual-deploy-steps.md, docs/handoffs/2026-10-20-refactor-handoff.md.
- AXKH_NODE_AND_DECISIONS_PLAN.md, docs/axkh-node/README.md.

## 14. Codex 검토 요청

Codex는 코드를 수정하지 않고, 이 문서와 repo를 읽어 아래를 검토한다.

1. 전략 타당성: 전면 재작성 대비 strangler 결론이 현재 코드에 비춰 맞는가, 재설계가 필요한 영역(예: 프로세스 내 작업 큐)이 있는가.
2. 단계 순서와 의존: 5.4 순서가 맞는가, 순환 import나 숨은 공유 상태 때문에 순서를 바꿔야 하는 단계가 있는가.
3. 누락 위험: 8절에 없는 위험(배포, 데이터, 인증, 동시성).
4. 테스트와 롤백 적정성: 특히 T1-0a parity 테스트 설계와 T1-9/T1-10 검증이 충분한가.
5. 줄 번호 정확성: 5.2, 5.3, 6절의 줄 번호가 HEAD d780d73과 맞는가.
6. Best-practice 빈틈: 12절의 Gap 두 개에 대한 제안과 놓친 관행.

피드백 형식:
- 번호가 붙은 finding 목록.
- 각 finding에 심각도(High, Med, Low), 이 문서의 절 번호와 repo 파일:줄 참조, 구체적인 수정 제안(바꿀 문장이나 추가할 단계)을 적는다.
- 동의하는 부분은 짧게 "동의"로만 적고, 확인하지 못한 것은 확인하지 못했다고 적는다.
