# 운영 안정성 종합 기술 리뷰

## 2026-09-29 최신 리뷰

### 검토 기준과 결론

- 기준 커밋: `79d098f74ca162daf63b8fbd248468c4ef3c130a` (`main`, 2026-09-08 11:36:14 -0700).
- 커밋 제목: `feat(memory): Step 4 phase 2b — prevent run-ons at the fold (update=rewrite, not append)`.
- 검토 시작 시 변경: ` M supabase/.temp/cli-latest` 1개. 이 사용자 변경은 수정하지 않았다. 앱 소스·설정·DB·배포는 변경하지 않았다.
- 환경: Windows/PowerShell, Node.js `v22.12.0`, 로컬 설치 의존성 사용. 의존성 설치·업데이트, 서버 기동, 운영 API/DB 호출, 배포를 하지 않았다. 빌드가 생성한 gitignored `dist/`, `workflow-server/build/`, `public/version.json`은 검증 산출물이다.
- 기존 `REVIEW.md`는 없었다. 기존 리뷰인 `RELIABILITY_AUDIT_KO.md`를 이 문서의 과거 기록으로 원문 보존하고, 최신 리뷰를 그 위에 작성했다. 기존 KO/EN 감사 파일 및 모바일 감사 파일도 그대로 유지했다.
- 먼저 읽은 기준 자료: `README.md`, `AGENTS.md`, `workflow-server/README.md`, 기존 KO/EN 신뢰성 감사, `DEV_NOTES.md`, `LOCAL_DEV.md`, `RUNBOOK.md`, `OPS_BACKLOG.md`, Render 통합 및 memory/speaker 설계 문서. 모바일은 README·기존 Flutter 감사와 핵심 인증/업로드/잡/저장 구현을 보조 검토했다.

**전체 판단:** 재시도·에러 표시·인증 갱신·잡 추적 등은 과거 감사보다 개선됐다. 그러나 서비스 역할을 사용하는 오디오 서명과 조직 접근 제한, 메모리 갱신의 데이터 손실, 녹음 저장 경로에 우선 수정할 문제가 있다. 빌드와 순수 단위 테스트 통과는 이 경계들의 안전성을 입증하지 않는다. P0로 확정할 근거는 없었다.

아래의 **확인**은 현재 소스의 실행 경로 또는 외부 I/O를 대체한 모의 실행으로 확인했다는 의미다. 운영에서 이미 사고가 발생했다거나 현재 배포가 동일하다는 뜻은 아니다. DB 관련 결론은 저장소 migration을 기준으로 하며, 운영의 추가 정책·트리거·배포된 Edge Function은 확인하지 않았다.

### 프로젝트 성격과 검토 비중

회의 음성은 다시 만들기 어렵고, AI 처리에는 비용과 긴 대기 시간이 든다. 따라서 코드 스타일보다 원본 보존, 사용자 격리, 중복 과금, 완료/실패 상태의 진실성을 우선했다.

| 영역 | 구조와 주요 흐름 | 검토 비중 |
|---|---|---|
| 원본 녹음·업로드 | 웹 MediaRecorder → 메모리/IndexedDB/클라우드 draft → Supabase Storage 및 `file`; 모바일은 로컬 파일과 업로드 재시도 | 높음: 음성 유실과 재시작 |
| 비동기 작업 | `/summarize-audio/jobs` → `workflow_job` → 프로세스 내 실행 → AssemblyAI 제출/폴링 → Gemini → `note` 저장 → 완료 상태 | 가장 높음: 상태·멱등성·부분 실패 |
| 후처리 | 완료 응답 이후 memory fold, `note_insight`, 단일 화자 이름 보완 | 높음: 경쟁 쓰기·소유권·복구 |
| 인증/데이터 | MSAL/Graph → 조직 제한이 있는 `supabase-token` → JWT/RLS; backend/Edge/MCP는 service role을 써서 별도 권한 검사가 필요 | 가장 높음: 사용자 격리 |
| 공유·검색·재생 | 노트 직접 공유/프로젝트 공유, MCP 검색, 오디오 URL 재발급, Teams 전달/OneDrive 내보내기 | 중간~높음: 접근 규칙과 UI 일치 |
| 운영 | Render의 통합 backend+MCP, 별도 Edge 배포, 수동 모바일 배포, 이메일/F9, migration ledger | 높음: 검증·관측·배포 실패 |

기본 흐름의 DB 쓰기는 여러 요청으로 분리되어 있다. Storage→file→job→note→job 완료→memory/insight는 하나의 트랜잭션이 아니다. 프로젝트/노트 양방향 연결 RPC는 DB 함수 안에서 처리되어 상대적으로 좋지만, 잡과 후처리는 별도의 복구 설계가 필요하다.

다음은 의도적 정책으로 존중했다: webhook 전환과 유료 호스팅/외부 모니터링 보류, 음성 생체 특징 사용 제외, 다중 화자 자동 적용 중단, translation 비활성화, 전체 entity graph 보류, memory 후처리를 요약 완료 뒤 best-effort로 실행하는 선택. 이들 기능의 부재 자체를 결함으로 세지 않았다.

### 발견 사항 요약

| ID | 심각도 | 확인한 문제 |
|---|---|---|
| R01 | P1 | 소유한 노트에 다른 파일/경로를 연결하면 service role로 타인 Storage 객체 URL을 발급할 수 있음 |
| R02 | P1 | 조직 제한을 우회하는 Graph 인증 경로로 유료 AI 작업을 실행할 수 있음 |
| R03 | P1 | memory 읽기 실패 또는 동시 fold가 기존 개인 메모리를 덮어씀 |
| R04 | P1 | IndexedDB가 부분 저장된 경우 완전한 메모리 음성 대신 불완전한 녹음을 확정함 |
| R05 | P2 | 공유 노트 재생성 시 요청자 ID로 소유자의 `note_insight`를 덮어씀 |
| R06 | P2 | 잡 생성의 조회→삽입 경쟁과 웹 재시도 ID 재생성으로 중복 처리·과금 발생 |
| R07 | P2 | 완료 상태 쓰기 실패를 무시하고, orphan sweep은 완료된 잡을 실패로 덮어쓸 수 있음 |
| R08 | P2 | 프로젝트 공유 권한이 오디오·검색 경로에 일관되게 반영되지 않음 |
| R09 | P2 | 인증 미완료 상태에서 15초 후 null 토큰으로 진행하며 토큰 교환에도 시간 제한이 없음 |
| R10 | P2 | 오디오 서명 URL의 1시간 만료를 UI 캐시가 무시함 |
| R11 | P2 | 공식 QA 명령·eval 타입 검사·린트가 실패하고 중요한 장애 경계를 검증하는 자동 gate가 없음 |
| R12 | P3 | 관리자 모델 선택 및 운영 문서가 현재 실행 동작과 다름 |

P1은 기밀성/원본·누적 데이터 손실 위험으로 우선 대응, P2는 주요 기능·복구·검증 실패로 다음 배치 대응, P3는 운영 오판을 줄이는 정합성 개선이다.

### R01 — P1: 오디오 서명 기능이 타인 객체의 대리 서명기로 동작

**위치:** `supabase/functions/note-audio-url/index.ts:140,216,219,239`; `supabase/migrations/20260602124000_enable_user_data_rls.sql:51`; `20260605120000_add_note_audio_file_id.sql:1`; `workflow-server/src/index.ts:589,1189`.

**발생 조건:** 로그인 사용자가 자기 `note`의 `audio_file_id`를 접근 권한이 없는 파일 ID로 지정하거나 `audio_file`을 알고 있는 타인 Storage 경로로 지정한다. 자기 노트의 INSERT/UPDATE 정책은 `user_id`만 제한하며 파일 소유자/경로 관계는 검사하지 않는다. 파일 FK도 존재 여부만 보장한다. 객체 ID/경로를 알아야 하며, 무작위 UUID를 자동 발견하는 취약점을 주장하는 것은 아니다.

**영향:** 함수는 노트 접근 권한만 통과하면 service role로 파일을 조회하고 서명한다. 레거시 URL은 호스트·허용 bucket·사용자 경로도 검증하지 않고 pathname에서 bucket/path를 뽑는다. 과거 공유받아 경로를 알고 있는 객체의 접근이 철회된 뒤에도 자기 노트로 새 URL을 발급받을 수 있다. 음성뿐 아니라 service role이 접근 가능한 다른 private bucket 객체에도 적용된다.

**근거:** Edge 함수 전체를 로컬 VM에서 실행하고 Graph·DB·Storage만 mock했다. Alice 소유 노트의 `audio_file_id=bob-file`에 대해 Bob 경로 서명 요청과 HTTP 200을 관찰했다. `https://untrusted.invalid/storage/v1/object/public/other-private/bob/secret`에서도 `other-private/bob/secret` 서명이 호출됐다. 실제 객체 다운로드/운영 공격은 수행하지 않았다.

**개선:** 클라이언트가 편집 가능한 URL/파일 행을 권한 증거로 사용하지 않는다. 업로드부터 서버가 검증한 note→file→object 소유 관계를 유지하고, 공유는 검증된 노트 소유자의 객체에 한해서 허용한다. file 소유권 비교만 추가하면 클라이언트가 자기 file 행에 타인 경로를 쓰는 우회가 남으므로 Storage 경로/업로드 주체도 확인해야 한다. 레거시 서명은 허용 host/bucket과 실제 파일 소유 관계로 제한한다.

### R02 — P1: 조직 계정 제한이 유료 실행 경로까지 이어지지 않음

**위치:** `workflow-server/src/index.ts:622,1798,2081,2133,2956`; `supabase/functions/generate-profile/index.ts:75,711`; `supabase/functions/identify-speakers/index.ts:81,696`; 비교: `supabase/functions/supabase-token/index.ts`의 allowlist gate.

**발생 조건:** 허용 조직 밖 사용자가 Microsoft Graph `/me`에 유효한 토큰으로 backend에 직접 요청한다. `getMicrosoftUserId`는 ID만 얻고 조직 allowlist를 확인하지 않는다. JSON 작업은 `summaryRulesOverride`가 있으면 사용자 소유 prompt 조회까지 생략한다. Android multipart 경로는 서버 기본 prompt를 사용한다. profile/identify Edge의 Microsoft 토큰 fallback도 같은 조직 검사를 생략한다.

**영향:** UI 로그인/앱 JWT 발급은 거절되더라도 AssemblyAI·Gemini 비용과 backend/DB 자원을 사용할 수 있다. `userId` 일치 검사는 타인 사칭을 막지만 조직 사용 자격을 검증하지는 않는다. 익명 무인증 실행이 가능하다고 주장하는 것은 아니다.

**근거:** 실제 `getMicrosoftUserId`와 `createSummarizeJob`을 실행하고 `/me`만 외부 조직 ID로 mock했을 때 잡 삽입과 pipeline 실행이 허용됐다. Edge fallback과 `supabase-token` gate의 차이도 정적으로 확인했다. 실제 외부 조직 계정/운영 gateway 정책은 미검증이다.

**개선:** backend/Edge의 공통 인증 경계에서 검증된 조직 JWT 또는 동일한 조직 allowlist 정책을 강제한다. 앱 JWT만 허용하는 전환은 모바일/MCP 등 토큰 계약을 확인해 순차 적용한다. 사용자별 유료 작업 한도는 추가 방어이며, 조직 인증 누락을 대체하지 않는다.

### R03 — P1: memory의 읽기 실패·동시 요청으로 누적 데이터 손실

**위치:** `workflow-server/src/memory.ts:1208,1216,1242,1245`; `workflow-server/src/index.ts:2030,2602`; `src/lib/userMemory.ts:54`.

**발생 조건:** (a) `user_memory` SELECT가 `{data:null,error:...}`를 반환한 뒤 다음 쓰기는 성공하거나, (b) 같은 사용자의 두 요약/재생성이 동시에 완료되거나, (c) fold 중 사용자가 memory를 삭제한다.

**영향:** 읽기 결과에서 `error`를 버려 빈 memory로 AI 처리를 계속하고 기존 행 전체를 upsert한다. 동시 요청은 같은 이전 스냅샷을 읽고 각자 계산한 전체 JSON과 `processed_note_ids`를 쓰므로 마지막 쓰기가 앞선 변경을 잃는다. 삭제 후 진행 중 작업이 memory를 재생성할 수도 있다. 손실된 처리 이력 때문에 재처리 판단도 틀어진다.

**근거:** 실제 `foldNoteIntoMemory`에 DB와 LLM 결과만 mock했다. 동시 `n1/n2` 처리 후 `prior-note,n2`만 남았고, 읽기 오류 후 `n3` 처리에서는 기존 사실과 처리 이력이 모두 `n3`만으로 대체됐다. 단순 AI 품질 추정이 아니라 쓰기 경쟁/오류 분기의 재현이다. 삭제와의 경쟁은 코드 추적으로 확인했으며 별도 동적 재현은 하지 않았다.

**개선:** 읽기 실패 시 fold를 중단하고 재시도한다. 사용자별 revision/CAS로 스냅샷 변경을 검출해 다시 계산하거나 사용자 단위 작업 직렬화를 적용한다. LLM 호출 동안 DB 트랜잭션을 오래 유지하지 않는다. 삭제는 generation/tombstone으로 이전 작업의 쓰기를 거절하고, 처리 이력과 memory 변경은 원자적으로 저장한다.

### R04 — P1: 로컬 일부 청크 저장 실패가 실제 녹음 파일 누락으로 이어짐

**위치:** `src/context/RecorderContext.tsx:572,575,592,689,708,745`.

**발생 조건:** 메모리에는 청크 A+B가 있지만 IndexedDB 용량 부족/쓰기 실패 등으로 A만 남아 있다. `saveChunk` 실패 시 UI는 페이지를 열어 두라고 안내한다. 그러나 녹음 종료 시 `persistedChunks.length > 0`이면 메모리의 완전한 청크 대신 DB의 일부 청크를 선택한다.

**영향:** 최종 Blob에 음성 일부가 빠지고 곧바로 메모리 청크를 비운다. 후속 전사·요약은 불완전한 원본을 정상 입력으로 처리할 수 있다. 마지막 2초뿐 아니라 저장 실패 이후 구간 전체가 영향을 받을 수 있다. 별도 cloud draft가 성공한 경우 복구 가능성은 있으나 이 함수는 완전성을 비교하지 않는다.

**근거:** TS AST에서 실제 `finalizeRecording` callback을 추출해 메모리 `AB`, DB `A`를 주입했다. 최종 Blob은 `A`, 종료 후 메모리 배열은 빈 배열이었다. 정상 IndexedDB의 이벤트 순서가 항상 어긋난다는 주장은 하지 않는다.

**개선:** 현재 녹음 세션의 메모리 청크를 우선하거나, 청크 번호·개수·총 바이트를 비교해서 완전한 소스를 선택한다. 미완료 쓰기는 추적해 flush하고, 누락이 있으면 정상 저장으로 확정하지 않는다. 파일 검증과 사용자의 보존 확인 이전에 복구 소스를 제거하지 않는다.

### R05 — P2: 공유 노트 재생성이 insight 소유자를 요청자로 바꿈

**위치:** `workflow-server/src/index.ts:2520,2549,2595,2602`; `workflow-server/src/memory.ts:541,548,1253`; `supabase/migrations/20260807140000_create_note_insight_and_search_indexes.sql:37`.

**발생 조건:** Alice의 직접 공유 노트를 Bob이 재생성한다. 접근 검사는 공유 사용자를 허용한다. 요약 prompt에는 Alice의 memory를 넣지만 후속 fold에는 `userId: tokenUserId` 즉 Bob을 전달한다.

**영향:** Bob의 memory 처리 이력에 없는 노트이면 `note_insight`를 `note_id` 충돌 기준으로 upsert하면서 `user_id`를 Bob으로 바꾼다. 원 소유자의 RLS 조회/브리핑·검색 인덱스와 데이터 소유자가 어긋난다. Bob의 memory에 공유 노트를 넣는 것이 허용된 제품 정책이더라도 원 노트 인덱스의 소유자를 바꾸는 것은 별개다.

**근거:** 실제 재생성 handler에서 owner=Alice/caller=Bob으로 mock한 결과 memory 조회 ID는 Alice, fold ID는 Bob이었다. 이어지는 실제 `writeNoteInsight`의 `onConflict:'note_id'`와 `user_id` 쓰기를 추적했다. 비교 대상인 `refreshNoteInsight`는 올바르게 `ownerId`를 전달한다.

**개선:** note index 쓰기에는 반드시 서버에서 읽은 `note.user_id`를 사용한다. 요청자의 개인 memory 갱신을 허용할지는 별도 정책/별도 저장으로 분리한다. 기존 `note_insight.user_id <> note.user_id` 데이터는 읽기 전용 감사 후 보정한다. owner의 private memory를 공유 사용자의 임의 instructions/diarization과 같은 LLM prompt에 넣는 경로는 정보 유출 검증도 추가해야 한다(실제 유출 출력은 이번 검토에서 재현하지 않음).

### R06 — P2: 동시 잡 생성과 웹 재시도에 멱등성이 부족

**위치:** `workflow-server/src/index.ts:2081,2093,2115`; `supabase/migrations/20260601122000_create_workflow_job_table.sql:1`; `src/pages/TranscriptionSummary.tsx:1184,1193,1234,1275`.

**발생 조건:** 동일 `(user_id,note_id)`의 요청이 겹쳐 모두 기존 job 없음으로 조회한다. 저장소 migration에는 이를 막는 unique 제약이 없다. 또 웹은 POST 응답이 유실되거나 폴링 재시도를 소진한 뒤 다시 실행하면 새로운 noteId를 생성한다.

**영향:** 두 pipeline이 유료 전사/요약을 실행한다. 동일 noteId 경쟁은 마지막 note INSERT에서 중복 키 오류가 나더라도 비용은 이미 발생한다. 웹의 새 ID 재시도는 실제 중복 노트까지 만든다. 폴링의 통신 실패를 서버 잡 실패처럼 취급해 localStorage 추적을 지우는 동작도 중복을 유도한다.

**근거:** 실제 `createSummarizeJob`에 두 동시 요청을 넣고 조회만 같은 빈 스냅샷으로 mock하자 job 2개·pipeline 실행 2개가 관찰됐다. 웹의 noteId 생성 위치와 실패 시 `clearActiveSummaryJob`도 확인했다. 모바일의 안정적인 noteId/fileId 재사용은 개선되어 있으며, 이것만으로 DB 경쟁을 막지는 못한다.

**개선:** DB unique 제약/트랜잭션으로 하나의 작업만 claim하고 충돌 요청은 기존 job을 반환한다. 실패 재시도는 attempt를 별도 관리한다. 웹도 제출 전에 사용자별 안정적인 요청 ID를 저장하고 응답 유실 후 조회로 재결합한다. 통신 불명 상태와 서버의 terminal failed를 구분한다.

### R07 — P2: job 상태를 신뢰할 수 없는 두 부분 실패 경로

**위치:** `workflow-server/src/index.ts:1768,2233,2250,2284,2305,3480,3502`.

**발생 조건/영향:**

1. note 저장은 성공했지만 완료 상태 UPDATE가 5회 모두 실패한다. `updateWorkflowJob`의 `false`를 무시해 success cache에 넣고 후처리를 계속한다. GET은 DB status가 completed일 때만 cache를 반환하므로 사용자는 결과를 받지 못한다. 나중에 orphan sweep이 failed로 바꾸면 이미 저장된 노트와 UI 상태가 모순된다. 같은 noteId 재시도는 기존 note와 충돌할 수 있다.
2. orphan SELECT 후 UPDATE 사이에 원 worker가 heartbeat/완료를 기록한다. sweep UPDATE는 ID만 조건으로 쓰므로 이미 completed가 된 작업도 failed로 바꿀 수 있다.

**근거:** 실제 worker/status updater에서 terminal UPDATE 5회를 실패시킨 결과 오류 incident 발생 없이 cache 저장까지 진행했다. 실제 sweep에서 SELECT 직후 completed로 바꾼 행은 최종 failed가 됐다. 두 동작 모두 외부 DB 없는 모의 실행이다.

**개선:** 완료 쓰기 실패를 별도 운영 오류로 기록하고 `note` 존재와 저장 결과를 이용해 durable reconciliation을 수행한다. sweep은 UPDATE에도 현재 상태+stale cutoff를 적용하거나 lease/version 조건을 사용한다. completed/failed 전이는 조건부 원자 쓰기로 제한한다. webhook 전환 없이도 먼저 고칠 수 있다. 현재 sweep은 실패시키는 복구이며 기존 전사 결과에서 실행을 재개하는 checkpoint 복구는 아니다.

### R08 — P2: 프로젝트 공유 권한이 읽기·재생·검색마다 다름

**위치:** `supabase/migrations/20260630123000_fix_project_sharing_rpcs.sql:43`; `supabase/functions/note-audio-url/index.ts:209,216`; `workflow-server/src/mcp/lib/supabase.ts:100`; `supabase/migrations/20260810190000_search_notes_rpc_v2.sql:63`; `workflow-server/src/mcp/tools/notes.ts:260`.

**발생 조건:** 노트 소유자가 공유한 프로젝트를 통해서만 노트 접근이 가능한 사용자(직접 `shared_users`에는 없음).

**영향:** note RLS와 MCP 일반 노트 조회에는 프로젝트 공유가 포함되지만, 오디오 Edge는 프로젝트를 읽지도 않고 403을 반환한다. MCP `search_notes`는 프로젝트 공유가 빠진 SQL RPC를 사용하므로 일반 조회 가능한 노트가 검색에서 사라진다. `SummaryHistory.tsx:690`의 직접 공유 필터도 프로젝트 공유를 좁힌다. 목록/검색에서의 정확한 제품 분류는 의도 확인이 필요하지만 재생 권한 및 MCP 검색 불일치는 명확하다.

**근거:** 프로젝트로만 공유된 노트에 대해 오디오 handler mock은 403이었다. RLS의 세 번째 OR 분기, MCP 조회의 owner별 project 분기와 search RPC의 두 분기를 비교했다. 운영 RPC가 별도로 수정되었는지는 미확인이다.

**개선:** `can_read_note` 같은 DB 권한 함수를 기준으로 앱/Edge/MCP를 맞추고, owner/direct share/project share/revoked의 권한 매트릭스를 테스트한다. 읽기 허용을 편집 허용으로 확대하지 않는다.

### R09 — P2: 인증 대기 시간 초과가 아직 익명 조회로 이어짐

**위치:** `src/config/supabaseConfig.ts:51,62,77,86`; `src/context/AuthContext.tsx:114`.

**발생 조건:** auth가 signed-out으로 확정되지도 않고 provider 등록도 되지 않은 상태로 15초가 지난다. 또는 토큰 교환 fetch가 응답 없이 오래 대기한다.

**영향:** 이전 5초 timeout이 15초로 늘었지만 timeout 후 null token을 반환하는 분기는 남았다. Supabase 요청은 인증 사용자 token 없이 진행해 데이터 접근 실패/빈 결과를 유발할 수 있다. 한편 exchange single-flight promise에는 fetch timeout이 없어 한 요청이 정체되면 후속 DB 요청과 백그라운드 갱신도 함께 묶인다. 재시도 횟수는 응답이 끝나야 효과가 있다.

**근거:** 실제 provider 대기/토큰 반환 함수를 timeout 즉시 진행 mock으로 실행했다. `authResolvedWithoutUser=false`인 채 null이 반환됐다. exchange fetch에 AbortSignal/시간 제한이 없는 것도 확인했다. 전체 브라우저에서 15초 지연 로그인 E2E는 미실행이다.

**개선:** 명시적인 signed-out만 익명 접근을 허용하고, 인증 미완료 timeout은 복구 가능한 auth 오류로 표시한다. 교환 요청에 deadline과 취소를 넣고 single-flight 정체를 해제한다. 기존 5분 선제 갱신과 아직 유효한 token 재사용은 유지한다.

### R10 — P2: 오래 열린 화면에서 오디오 URL 만료 후 재생 복구 불가

**위치:** `src/pages/SummaryHistory.tsx:487,1618,1647,1736`; `supabase/functions/note-audio-url/index.ts:10,235`.

**발생 조건:** 노트 상세를 열어 URL을 미리 받거나 한 번 재생하고 1시간 이상 같은 페이지를 사용한 뒤 다시 접근/seek/download한다.

**영향:** Edge는 `expiresIn:3600`을 반환하지만 클라이언트는 URL 문자열만 영구 Map에 넣고 무조건 재사용한다. 재생 실패 후에도 캐시 제거/재서명이 없어 같은 만료 URL을 다시 쓸 수 있다. 브라우저가 이미 받은 media bytes를 재사용할 때는 즉시 드러나지 않을 수 있다.

**근거:** Edge TTL과 UI cache hit/set, 재생 함수의 직접 cache hit 경로를 정적으로 연결했다. 브라우저에서 실제 1시간 대기하거나 운영 URL을 발급받지 않았다.

**개선:** 서버 만료 시각을 함께 저장하고 여유 시간을 두고 재발급한다. 인증/만료에 해당하는 재생 오류에서는 캐시 제거 후 1회만 재시도하고, 계속 실패하면 명확한 오류를 보여준다.

### R11 — P2: 공식 검증 경로가 재현 가능하지 않고 핵심 장애를 놓침

**위치:** 루트 `package.json`의 `test:qa`/devDependencies; `.eslintrc.cjs`; `workflow-server/eval/briefing-probe.ts:54`; `.github/workflows/tag-mobile-release.yml`; `workflow-server/src/*.test.ts`.

**발생 조건/영향:** 루트 `npm run test:qa`는 선언/설치되지 않은 `tsx`를 호출해 실패한다. `typecheck:eval`은 현재 타입 오류로 실패한다. lint는 51 errors/6 warnings이며 루트 QA runner는 여기서 종료되어 뒤의 QA tests도 실행하지 못한다. 저장소 내 유일한 GitHub workflow는 모바일 tag 생성이며 build/test/eval gate를 실행하지 않는다. Render dashboard의 별도 gate 존재 여부는 확인하지 않았다.

**근거:** 아래 검증 결과에 실제 실행 기록을 기재했다. backend 74 tests는 parser, memory operation, ops fingerprint, speaker 판단 등이며 DB 경쟁·권한·잡 전이 통합 테스트는 없다. 테스트 수 자체를 품질 지표로 사용하지 않았다.

**개선:** 루트 QA runner의 실행 의존성을 명시하고 eval 타입 오류와 lint gate를 정상화한다. lint 경고 전체를 장애로 분류하기보다 신뢰 가능한 gate를 먼저 복구한다. 이후 R01~R09의 권한/실패 주입/동시성 테스트를 isolated DB/mock으로 CI에 연결한다. 유료 eval과 운영 DB 테스트는 별도 승인·격리된 job으로 나눈다.

### R12 — P3: 관리 UI 및 문서가 운영 판단을 오도할 수 있음

**위치:** `src/pages/AdminControls.tsx:30,114,213`; `workflow-server/src/index.ts:235,1235`; `workflow-server/README.md`; `RUNBOOK.md:36`; `DEV_NOTES.md:70`; `workflow-server/eval/README.md`.

**조건/영향:** 관리자는 Universal 3 Pro/Universal 2 설정을 저장할 수 있지만 production submit은 `ASSEMBLYAI_PRODUCTION_TRANSCRIPTION_MODELS=['universal-2']` 상수를 보낸다. README는 DB/env 모델 설정이 사용된다고 설명한다. 고정 모델 선택 자체가 정책일 수 있지만 UI의 선택이 실제 적용된다고 보이게 하는 것은 운영 정합성 문제다.

추가로 RUNBOOK은 제거된 `update-user-memory` Edge Function을 배포 목록에 포함한다. `DEV_NOTES`는 n8n·제거된 SaveSummary/JSZip 등 역사 내용을 현재 구조와 섞고, eval README는 “gate 아님”이라고 하지만 `eval:gate` 명령은 존재한다. RUNBOOK의 “Jobs are safe once submitted”는 in-process 실행, orphan 실패 처리, 웹 통신 실패 시 추적 제거의 한계를 설명하지 않는다. 과거 감사의 프로덕션 dev-server 지적은 현재 build/static 문서만으로 운영 해결을 확정할 수 없다.

**근거/개선:** 코드 상수→submit body와 관리 UI 저장을 추적했다. 관리 화면에 실제 고정 모델/설정 적용 범위를 표시하고 README/runbook을 현 배포 단위와 복구 한계에 맞춘다. Render frontend의 실제 정적 배포·현재 SHA, Edge deployment 목록과 migration ledger는 운영 read-only 검증 과제로 둔다.

### 기존 리뷰 재확인

상태는 **해결**, **미해결(부분 개선 포함)**, **기능 제거**, **운영 검증 필요**를 구분했다. 옛 줄 번호가 아니라 현재 코드를 확인했다. 명시적으로 보류한 기능은 해결되지 않았다는 이유만으로 신규 결함으로 올리지 않았다.

| 과거 항목 | 현재 판단 | 근거/남은 부분 |
|---|---|---|
| C1 두 번째 녹음 cleanup | 해결 | `RecorderContext.tsx:987` 이후 mount lifetime cleanup과 URL 정리가 분리됨. 원본 완전성은 별개 R04 |
| C2 재시작 후 processing 영구 잔류 | 부분 개선, 미해결 영역 있음 | heartbeat+5분 stale 기준+2분 주기 sweep 추가. 실행 재개가 아닌 실패 처리이며 R07 남음 |
| C3 폴링 1회 실패로 전체 실패 | 해당 단발 실패는 해결 | 웹 5회 연속 실패 허용/갱신/backoff. Graph `/me` 매 poll 호출과 통신 실패 후 추적 제거는 남음(R06) |
| C4 Error Boundary 없음 | 해결 | `src/main.tsx` root boundary 존재. 모든 라우트별 boundary까지 있다고 판단하지 않음 |
| C5 anon fallback | 미해결, 부분 개선 | auth wait/signed-out 구분 추가, 15초 timeout의 null fallback 잔존(R09) |
| C6 토큰 교환 무재시도/redirect | 부분 개선 | 3회 재시도·유효 token 재사용. 모바일 redirect는 정책, fetch deadline 부재는 미해결(R09) |
| C7 59분 갱신 절벽 | 부분 개선 | 5분 buffer·분당 갱신·single-flight. 정체된 exchange deadline은 미해결 |
| C8 새로고침 추적 소실/언마운트 폴링 | 해결된 경로 있음 | localStorage/AbortController 복구. 장기 통신 장애 시 추적 삭제는 R06 |
| C9 터치 노트북 redirect 오분류 | 해결 | `msalRedirect.ts`는 UA 및 pointer/hover를 사용, 화면 너비 의존 제거 |
| AssemblyAI poll 무재시도 | 해결 | `transcribeWithAssembly`에 연속 실패 허용. submit 실패 재시도/원격 transcript checkpoint는 별개 |
| Gemini 429/5xx 무재시도 | 해결 | `callGeminiWithFallback`의 retryable 처리·backoff |
| 요약 JSON 포맷 복구 없음 | 해결된 범위 있음 | `parsers.ts` brace-balanced object 복구. 잘린/잘못된 의미까지 복구 보장하지 않음 |
| 전사/요약 checkpoint 없음 | 미해결, 설계 보류 고려 | 원격 transcript ID/result에서 재개하는 durable 경로 없음. webhook 전환 자체는 보류 정책 |
| terminal 상태 쓰기 실패 은폐 | 미해결 | 재시도는 추가됐지만 반환 false 무시(R07) |
| 마지막 녹음 청크 유실 | 미해결 | fire-and-forget 저장 및 일부 persisted 우선 선택. R04로 구체화 |
| 웹 제목/요약 0행 수정 거짓 성공 | 해결 | SummaryHistory 제목/요약 변경에 select/maybeSingle+없음 검사 |
| history 조회 실패=빈 목록 | 해결 | `notesError` 및 재시도 UI, cancelled guard |
| 오디오 실패 UI 미표시 / URL 영구 캐시 | 미해결 | `SummaryHistory.tsx:1736` 재생 catch는 console 중심, TTL cache는 R10 |
| 업로드 상세 오류 미표시 | 해결 | TranscriptionSummary의 `uploadError` 렌더링 |
| env example/검증 부재 | 부분 해결 | 양쪽 `.env.example`, frontend `getMissingEnvVars`, backend `env:check` 있음. doctor가 start/build의 강제 조건은 아님 |
| supabase-token 테넌트 무제한 | 해당 발급 경로는 해결 | allowlist fail-closed. 다른 Graph 경로 R02는 남음 |
| generate-profile 무인증 | 익명 접근 문제는 해결, 조직 제한 미해결 | JWT 또는 Graph 필요, Graph fallback 조직 gate 없음(R02) |
| Project n8n webhook 무기한 대기 | 기능 제거 | 현재 `/project-chat`/stream 경로로 교체됨 |
| 중복 제출 | 미해결, 부분 개선 | 모바일 키 안정화·backend 사전 조회. 원자성/웹 재시도 R06 |
| 검색 전체 select/무debounce | 미해결 | history search는 select('*') 후 클라이언트 필터; 검색 시 pagination 해제. 큰 데이터셋 성능/서버 반환 상한 E2E는 미검증 |
| profile Promise.all 단일 실패 전파 | 미해결 | TranscriptionSummary:1556, SummaryHistory:2058 |
| stale effect 응답 | 주요 history 경로 해결 | cancelled 확인. 전체 effect의 완전 해결은 주장하지 않음 |
| stop onstop 무기한 대기 | 미해결 가능성 | stop resolve 경로는 종료 이벤트/finalize에 의존. 브라우저 이벤트 유실은 재현하지 않아 우려로 유지 |
| 동기 summarize 장시간 요청 | 미해결, 잔존 경로 | `/summarize-audio` 유지. 주 사용 경로는 async job |
| SaveSummary alert 다수 | 기능 제거 | SaveSummary 페이지 제거. 현재 모든 UI 오류 처리 완료 의미는 아님 |
| 거대 파일/복제 구조 | 미해결 구조 부채 | 장애 수정 누락 가능성의 맥락으로만 기록, 파일 크기 자체를 신규 결함으로 세지 않음 |
| production Vite dev server | 운영 검증 필요 | 현재 build/static runbook 있음. 실제 배포 endpoint를 조회하지 않았음 |

모바일 기존 감사는 핵심 운영 경로 위주로 재확인했다. 과거 T1은 workflow 401 interceptor와 token refresh 추가, R4는 replay timeout 추가로 해당 결함이 해결됐다. T2는 `ActiveJobStore`와 재시작 복구, T3는 stable noteId/fileId·업로드 중복 처리가 추가됐으나 R06의 서버 경쟁은 남는다. T4는 rename/delete/summary 등 대표 변경에 affected-row 검사가 추가됐지만 `shareNote`/`shareNoteWithMicrosoftUser`는 void PATCH라 **부분 개선·미해결**이다. R2의 실제로 작동하지 않던 refresh/deleteAll 분기는 **기능 제거**됐다. S1의 “클라이언트 userId를 그대로 신뢰”는 현재 Graph ID와 비교하므로 **해결**이다. R11의 최근 녹음 `list()` catch→빈 목록은 남아 있고, `exportToOneDrive`의 TODO/가짜 URL 반환도 구현에 남아 있으나 실제 UI 도달 여부는 이번에 확정하지 않았다. 모바일 설계/화면 기능 격차·iOS 장치 이슈 전체는 재감사 완료로 표시하지 않는다. 기존 모바일 감사 원문을 유지한다.

### 테스트·빌드 및 재현 결과

| 검증 | 결과 | 해석 |
|---|---|---|
| backend `npm test` | **74/74 통과** | 첫 실행은 sandbox `uv_os_get_passwd ENOMEM`; 권한 범위를 조정해 동일 명령 재실행 성공. 코드 메모리 부족으로 단정하지 않음 |
| backend `npm run build` | **통과** | strict TypeScript 컴파일 |
| frontend `npm run build` | **통과** | tsc+Vite. sandbox 상위 폴더 접근 거부로 esbuild가 처음 실패해 재실행. 1,097 modules; main JS 1,396.61 kB / gzip 379.12 kB, chunk 크기·오래된 Browserslist 경고 |
| 루트 `npm run lint` | **실패: 51 errors, 6 warnings** | unused/console/정규식 escape/constant condition/hook dependencies. 자동 수정하지 않음 |
| 루트 `npm run test:qa` | **실패** | `tsx`를 찾을 수 없음 |
| 설치된 backend tsx로 동일 QA 실행 | **5/5 통과, stderr 경고** | `.\workflow-server\node_modules\.bin\tsx.cmd scripts/qa-tests.ts`; `window is not defined` Realtime 초기 인증 경고가 함께 발생. 정식 명령 성공으로 대체해 기재하지 않음 |
| backend `npm run typecheck:eval` | **실패** | `eval/briefing-probe.ts:54`: `string | undefined`를 `string`에 할당(TS2322) |
| Flutter `analyze --no-pub` | **미검증** | SDK 명령이 수 분간 출력 없이 정체해 중단. 앱 분석 오류/성공 어느 쪽으로도 판정하지 않음 |
| Deno Edge check/로컬 Postgres migration 적용 | **미실행** | Deno CLI와 격리된 DB를 확인하지 못함 |
| live Gemini/AssemblyAI eval·실제 로그인 E2E | **미실행** | 유료 API/운영 데이터에 연결하는 env·harness; 격리 환경 미확인 |
| 모의 장애 재현 | **12개 예상 결함 동작 확인** | 아래 방법. 네트워크·실 DB 쓰기 없음 |

**모의 실행 방법:** 현재 파일을 읽어 TypeScript compiler의 AST/transpile로 실제 함수/콜백을 실행했다. Edge 오디오 함수는 import만 대체해 handler 전체를 실행했다. DB/Graph/Storage/LLM/타이머는 메모리 구현으로 대체했다. backend 서버 엔트리포인트를 import하거나 `.env`를 로드하지 않았다. 입력 파싱/HTTP transport/실 DB RLS까지의 통합 검증을 대체하지 않는다.

확인한 출력은 다음과 같다. PASS는 수정 완료가 아니라 **결함 조건의 예상 결과를 재현했다**는 뜻이다.

```text
PASS audio-file-reference: Alice-owned note produced signed URL for Bob file
PASS legacy-audio-path: arbitrary URL bucket/path signed with service role
PASS project-sharing: project-only member rejected before project lookup
PASS concurrent-job-create: 2 jobs and 2 pipeline launches for same user/note
PASS organization-gate: Graph-valid outside-org identity admitted without organization check
PASS terminal-write-failure: 5 failed DB writes ignored; success cached; no incident
PASS orphan-race: completed row overwritten to failed after stale scan
PASS concurrent-memory-fold: one of two new notes lost; final IDs=prior-note,n2
PASS memory-read-error: prior facts and processed IDs overwritten by new note
PASS shared-regenerate: owner memory read as Alice; fold/write identity is Bob
PASS recording-partial-store: persisted A preferred to complete in-memory AB; output A; memory cleared
PASS auth-unresolved: 15-second cap returns null token without logged-out resolution
```

재현 스크립트는 OS 임시 폴더의 `meeting-note-review-repro.cjs`, `meeting-note-review-repro-ui.cjs`에 작성했다. 앱 소스/테스트 파일을 추가하지 않았다. 재현의 지속 가능성을 위해 스크립트 원문을 이 문서 끝에 보존한다. 스크립트의 root 경로는 이 검토 환경 기준이며 다른 환경에서는 조정해야 한다.

### 추가 검증이 필요한 운영 우려

- **운영 schema/Edge 차이:** repository migration만으로 배포된 RLS·bucket policy·trigger·함수 권한을 확정할 수 없다. OPS_BACKLOG의 ledger 백필 기록은 과거 시점이며 현재 반영 보증이 아니다. 특히 당시 “caller 0인 dead RPC”로 적힌 `remove_current_user_from_note_shared_users`는 현재 모바일에서 호출된다. 실제 함수 존재 여부를 read-only로 확인해야 한다.
- **원본·첨부 후처리:** 웹 pending attachment는 완료 뒤 업로드되며 새로고침으로 File 객체가 사라질 수 있다. job body에 LLM용 base64가 들어가는 것과 note attachment가 영구 저장되는 것은 다르다. 모바일은 active job 저장이 추가됐으므로 별도 lifecycle 검증이 필요하다.
- **후처리 복구:** summary 완료 후 memory/index 실행 중 프로세스가 종료될 수 있다. best-effort 정책을 결함으로 세지는 않았지만 “요약 성공=memory/index 반영 완료”로 운영하면 안 된다. `processed_note_ids`가 있으면 insight 재시도도 건너뛰므로 일부 실패 보정 경로를 따로 확인해야 한다.
- **메모리 기밀성:** 공유 재생성은 소유자의 개인 memory를 공유 요청자의 가변 입력과 함께 LLM에 제공한다. prompt injection으로 실제 비공유 사실을 꺼내는지는 실험하지 않았다. “다른 사용자 memory를 결과 prompt에 넣어도 안전”을 전제로 두지 말고 데이터 사용 정책을 확인해야 한다.
- **장애 관측 공백:** `/health`는 프로세스 생존/설정 정보를 반환하며 DB/AssemblyAI/Gemini 성공을 보증하지 않는다. terminal write·orphan sweep·memory enrichment 실패는 주로 warn 경로라 F9/이메일과 같은 커버리지라고 볼 수 없다. `completedJobResults`는 완료 GET에서만 제거되어 클라이언트가 돌아오지 않으면 결과가 누적된다. 부하/OOM은 재현하지 않았다.
- **외부 API 부작용:** Teams send/OneDrive write와 note 메타데이터 기록은 외부 시스템과 단일 트랜잭션이 아니다. 응답 유실 시 중복 메시지/파일 여부, 대용량 업로드, Graph 429/토큰 만료는 격리된 계정으로 확인해야 한다. 이번 리뷰에서 실제 전송을 수행하지 않았다.
- **모바일/브라우저:** 2시간 녹음, OS 백그라운드 종료, 실제 장치의 IndexedDB quota·마이크 종료, iOS auth/녹음, 장시간 JWT 갱신, 음성 플레이어 TTL은 실기기 E2E가 필요하다.

### 잘 설계된 부분과 유지할 장점

- MSAL identity와 앱 JWT/RLS를 연결하고 server-only service role을 구분한다. token 발급 gate는 설정 누락 시 닫히고 MCP도 키가 없다는 이유로 열리지 않는다.
- MCP의 `AsyncLocalStorage` 요청별 사용자 scope, 직접/프로젝트 공유의 owner 조건, 공유 조회 실패 시 권한을 넓히지 않는 동작은 좋은 기반이다. static key의 신뢰 경로 자체를 일반 사용자 인증 결함으로 세지 않았다.
- async job, heartbeat, 주기적 orphan 처리, 모바일 stable ID와 active-job 보존, 웹 abort/resume는 이미 존재한다. 새 아키텍처를 전면 도입하기 전에 이 기반의 원자성과 실패 처리를 보완하는 편이 현실적이다.
- Gemini transient retry, AssemblyAI poll 내성, JSON 복구, 주 사용자 변경의 affected-row 확인은 단발 장애를 사용자 데이터 손실로 확장하지 않으려는 유용한 개선이다.
- 원본/편집 요약 분리, transcript speakerKey 보존, 화자 판단의 보수적인 자동 적용, deterministic memory operation 및 golden eval은 AI 결과의 품질을 다룰 근거를 제공한다.
- 프로젝트 연결/해제 RPC의 다중 행 변경을 DB 함수 안에서 처리하고 service-role 전용 RPC의 execute 권한을 제한한 점은 유지할 만하다.
- 녹음의 IndexedDB/cloud draft, 탭 간 녹음 lock, 시간 제한과 경고는 원본 복구를 고려한 설계다. R04를 고칠 때 이 기능을 단순 삭제하지 않아야 한다.
- commit 기반 version, 오류 이메일, F9 fingerprint 중복 억제/신규 티켓 상한, 수동 조치 원칙은 운영 추적에 도움이 된다. 외부 모니터링 보류와 구분해 내부 관측 공백을 좁히면 된다.

### 개선 우선순위와 권장 작업 순서

1. **권한 경계 먼저:** R01의 file/object 서명 검증과 R02의 공통 조직 인증을 수정한다. 격리 계정 A/B로 직접·프로젝트·철회 공유와 외부 조직 거절 테스트를 만든다. backend/Edge 호환성을 확인한 뒤 의존하는 frontend/mobile을 배포한다.
2. **데이터 보존:** R03의 SELECT 오류 중단 및 revision/CAS, R04의 녹음 완전성 확인, R05의 owner ID를 수정한다. 기존 memory/insight 보정은 read-only 범위 파악과 백업 후 별도 작업으로 수행한다.
3. **작업 상태/재시도:** R06 원자 claim과 stable ID, R07 조건부 상태 전이·저장 결과 reconciliation을 도입한다. `note 존재+job failed`, 응답 유실, 두 요청 경쟁, 배포 중 worker 종료를 테스트한다. 보류된 webhook 설계를 재개할 필요 없이 진행 가능하다.
4. **사용자 가시성:** R08 접근 규칙 통일, R09 auth 오류 상태/deadline, R10 TTL 갱신을 적용한다. 서버 진행 중/통신 불명/실패/완료를 UI에서 구분한다.
5. **검증·운영 계약:** R11 실행 명령/CI를 복구하고 R12 문서/UI를 현 동작에 맞춘다. 배포된 SHA·Edge 목록·migration ledger·알림 수신을 read-only로 검증한 뒤 isolated E2E를 수행한다. 모니터링/유료 호스팅 등 보류 정책은 별도 제품 결정으로 남긴다.

권장 완료 기준은 “테스트 녹색”만이 아니라, **타인 객체 서명 불가, 조직 외 과금 불가, 동시 fold에서 사실 보존, 부분 저장에서도 원본 보존, 같은 요청 1회 실행, note 저장 후 상태 실패에서 자동 재결합**이다.

---

## 과거 리뷰 원문 보존

다음은 기존 `RELIABILITY_AUDIT_KO.md` 원문이다. 과거 줄 번호·진단은 당시 기록이며 현재 결론은 위 재확인 표를 따른다. 영문 병행본과 `meeting-note-mobile/FLUTTER_AUDIT_KO.md`는 원래 경로에 보존했다.

# 종합 결과: 데모가 자주 깨지는 이유

근본 패턴은 3가지입니다.

1. **에러가 조용히 삼켜짐**: 실패해도 `console.error`만 찍고 UI는 정상인 척 함. 사용자는 "데이터가 없네?", "버튼이 안 먹네?"만 보게 됨
2. **일시적 실패에 재시도가 전혀 없음**: 네트워크 블립 1번, Graph API 429 1번이면 전체 워크플로우가 실패 처리됨
3. **거대 파일 + 로직 3중 복제**: 4,000줄짜리 페이지에 같은 로직이 3벌 복사되어 있어 한 곳을 고쳐도 다른 곳은 여전히 깨짐

---

## Critical (데모 즉사급)

| # | 위치 | 문제 |
|---|---|---|
| C1 | `src/context/RecorderContext.tsx:836-844` | **두 번째 녹음을 시작하면 새 녹음이 죽음.** effect cleanup이 `recordedAudioUrl` 변경 시마다 실행되어 새로 만든 스트림/타이머를 정지시킴 |
| C2 | `workflow-server/src/index.ts:1826,1915` | 서버 재시작/배포/크래시 시 진행 중이던 잡이 **영원히 `processing`에 갇힘.** 클라이언트는 1시간 동안 헛폴링 |
| C3 | `TranscriptionSummary.tsx:894-901` + `index.ts:1966,559` | 2.5초마다 폴링하는데 **폴링 1회만 실패해도 전체 실패 처리.** 게다가 백엔드가 폴링마다 Graph `/me`를 호출해서 Graph 한 번 삐끗하면 잘 돌아가는 잡이 "실패"로 표시됨 |
| C4 | `src/main.tsx`, `App.tsx` | **React Error Boundary가 앱 전체에 하나도 없음.** 4,000줄 페이지에서 렌더 에러 1개 = 흰 화면 |
| C5 | `src/config/supabaseConfig.ts:37-56` | 토큰 준비가 5초 안에 안 되면 **anon 키로 조용히 진행** → RLS가 빈 결과 반환 → 에러 없이 "노트가 없습니다" 표시. "데모 중에 내 데이터가 사라졌다"의 주범 |
| C6 | `src/context/AuthContext.tsx:90-133` + `supabaseConfig.ts:62` | 토큰 교환(MSAL → Graph → edge function) 실패 시 재시도 없이 **모든 DB 쿼리가 연쇄 실패.** 또는 redirect 모드면 **페이지 전체가 리로드**되어 녹음 등 모든 상태 소실 |
| C7 | `AuthContext.tsx:108` + `supabase-token` | Supabase JWT 수명이 정확히 60분, 만료 60초 전에야 갱신. 갱신 체인(MSAL→Graph→edge fn)에 타임아웃/재시도/중복제거 없음. **1시간짜리 데모는 59분쯤 절벽을 맞음** |
| C8 | `TranscriptionSummary.tsx:891-1096` | 요약 생성 중 **새로고침하면 잡 추적이 완전히 소실**(jobId 미저장). 페이지 이탈 시 폴링 루프가 언마운트된 컴포넌트에 setState 계속 |
| C9 | `src/lib/msalRedirect.ts:12-14` | 터치 지원 노트북 + 뷰포트 ≤1024px(프로젝터/화면분할)이면 **모바일로 오인해 redirect 모드 전환** → C6과 결합해 토큰 갱신 = 페이지 리로드. 정확히 데모 환경 프로파일 |

## High (데모 중 높은 확률로 발생)

**신뢰성 (재시도/체크포인트 부재)**

- `index.ts:1150` AssemblyAI 폴링 루프에 try/catch 없음, 네트워크 에러 1번 = 잡 전체 사망
- `index.ts:1601-1783` 스테이지 간 체크포인트 없음: 요약 실패 시 이미 돈 내고 받은 트랜스크립트도 폐기, 처음부터 재실행
- `index.ts:1684` + `parsers.ts:25` 프로덕션 요약 경로는 Gemini 출력 `JSON.parse` 실패 시 복구 로직 없음 (테스트 경로에는 있음)
- `index.ts:673` Gemini 429/500/503에 재시도 0회
- `index.ts:1586` 잡 상태 쓰기 실패를 `console.warn`으로 삼킴: 완료된 잡도 `processing`으로 방치 가능
- `RecorderContext.tsx:485,597` 마지막 청크 저장이 fire-and-forget이라 **녹음 마지막 ~2초 유실 가능**

**조용한 실패 (사용자에게 거짓 성공 표시)**

- `SummaryHistory.tsx:875,1799,1765` 공유받은 노트의 제목/요약 수정이 **0행 업데이트인데 성공으로 표시**, 새로고침하면 사라짐
- `SummaryHistory.tsx:749` 노트 조회 실패 = 빈 목록 표시, 에러 UI 없음
- `SummaryHistory.tsx:1745` 오디오 재생 실패 메시지를 만들어놓고 console에만 출력
- `SummaryHistory.tsx:1608` 서명된 오디오 URL을 만료 무시하고 영구 캐시
- `TranscriptionSummary.tsx:1891` 업로드 실패 사유를 저장해놓고 화면엔 "Error"만 표시

**설정/보안**

- `msalConfig.ts:17`, `supabaseConfig.ts:13` env 변수 누락 시 placeholder로 조용히 부팅, 나중에 알 수 없는 에러. `.env.example`도 없고 README에 Supabase 변수 미문서화
- `supabase-token`: `verify_jwt=false` + 테넌트 검증 없음이라 **전 세계 아무 Microsoft 계정이나 authenticated JWT 발급 가능**
- `generate-profile`: 인증이 아예 없어 누구나 Gemini 쿼터 소진 가능 → 데모 중 요약 사망
- `Project.tsx:552` n8n 웹훅 타임아웃 없음(행 걸리면 스피너 영구), URL 하드코딩

## Medium (요약)

- `alert()`/`confirm()` 남발 (SaveSummary 6곳, TranscriptionSummary 3곳): 데모 화면에서 브라우저 모달
- 중복 제출 방지 없음: 더블클릭 = 파이프라인 2회 결제
- 검색 키스트로크마다 전체 테이블 `select('*')` (트랜스크립트 포함) + 디바운스 없음
- `Promise.all`로 스피커 프로필 생성: 1명 실패 = 전체 실패
- 여러 useEffect에 cancelled 플래그 없음 (stale 응답이 최신 데이터 덮어씀)
- `stopRecording`이 `onstop` 이벤트를 타임아웃 없이 대기: 안 오면 Stop 버튼 영구 행
- 동기식 `/summarize-audio` 엔드포인트가 30분+ HTTP 요청 유지 (프록시 타임아웃에 취약)

## 구조적 문제

- **`SummaryHistory.tsx` 4,175줄** = 데이터 레이어 + 캘린더 엔진 + 오디오 재생 엔진 + 12개 뮤테이션 핸들러 + UI(노트 상세 패널이 3벌 복사됨), useState 50개
- **동일 로직이 페이지 3곳에 verbatim 복제**: 프로필 동기화 모달, Teams 전달 모달, 재생 엔진, transcript 저장 등. 실제로 0행 업데이트 버그가 한 copy에서는 고쳐졌는데 다른 두 copy는 그대로임
- **`workflow-server/src/index.ts` 2,164줄** = 라우팅 + 멀티파트 파싱 + 3개 벤더 클라이언트 + 잡 오케스트레이션 + 영속성이 한 파일
- 공유 데이터 액세스 레이어 없음: 페이지마다 Supabase 쿼리와 낙관적 업데이트를 손으로 재작성

---

# 개선 제안 (우선순위 로드맵)

**Phase 1: 데모 생존 킷 (효과 대비 작업량 최소)**

1. Error Boundary 추가 (전역 + 라우트별)
2. C1 녹음 cleanup 버그 수정
3. 폴링 내성: 연속 N회 실패까지 허용 + jobId를 localStorage에 저장해 새로고침 후 복구
4. anon 폴백 제거: 인증 미준비 시 명시적 "인증 중" 상태 표시
5. 토큰 선제 갱신 (50분 시점, 백그라운드) + 교환 실패 시 재시도
6. 서버 부팅 시 고아 잡 정리 + 잡 상태 쓰기 재시도

**Phase 2: 에러 가시화**

- 삼켜진 catch들을 UI 에러 상태로 연결 (빈 목록 대신 에러+재시도 버튼)
- `alert()` 제거, 인라인 에러/토스트로 통일
- 0행 업데이트를 실패로 처리 (`.select().maybeSingle()` 패턴 전파)
- env 검증 fail-fast + `.env.example` 추가

**Phase 3: 구조 개선**

- 파이프라인에 스테이지 체크포인트 + 벤더 호출 재시도 래퍼
- 공유 데이터 레이어(`useNotes`/`useNoteActions`) 추출, 3중 복제 제거
- 거대 페이지 분해
- edge function 인증 구멍 봉합 (테넌트 검증, generate-profile 인증)
- **[백로그, 2026-07-24 배포 중 발견]** 프로덕션 프론트가 Vite **dev** 서버로 서빙됨 (`meetingnote.tecace.com`이 `/@vite/client` + 원본 `/src/main.tsx` 반환): 소스가 공개로 읽히고, minify 안 되고, HMR 클라이언트가 프로덕션에 상주. Render 프론트를 `vite build` + 정적 서빙(또는 `vite preview` / 정적 호스트)으로 전환.

Phase 1만 해도 데모 체감 안정성이 크게 달라질 겁니다.
보안 이슈(supabase-token 테넌트 미검증)는 데모와 별개로 빠른 시일 내 처리를 권합니다.


---

## 재현 스크립트 원문 — 외부 I/O 없는 로컬 mock

### Backend / Edge

```javascript
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = 'C:/Users/andre/Projects/meeting-note/';
const ts = require(root + 'node_modules/typescript');
function extracted(file, names, injected) {
 const src = fs.readFileSync(root + file, 'utf8');
 const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
 const nodes = ast.statements.filter(n => n.name && names.includes(n.name.text));
 assert.equal(nodes.length, names.length);
 const js = ts.transpileModule(nodes.map(n=>n.getText(ast)).join('\n'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const c = vm.createContext({console, exports:{}, Date, Map, Set, ...injected});
 vm.runInContext(js,c); return c;
}
function chain(result) {const q={}; for(const k of ['select','eq','in','order','limit','lt']) q[k]=()=>q; q.maybeSingle=async()=>typeof result==='function'?result():result; q.single=q.maybeSingle; q.then=(ok,err)=>Promise.resolve(typeof result==='function'?result():result).then(ok,err);return q;}
(async()=>{
 // Execute the whole edge handler, replacing only imports and external services.
 let handler; let signed=[];
 let note={id:'owned-note',user_id:'alice',shared_users:[],audio_file_id:'bob-file',audio_file:null};
 const edge=fs.readFileSync(root+'supabase/functions/note-audio-url/index.ts','utf8').replace(/^import .*;\r?\n/gm,'');
 const context=vm.createContext({console,Request,Response,URL,TextEncoder,TextDecoder,atob,btoa,
 Deno:{env:{get:k=>({SUPABASE_URL:'https://mock.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake'})[k]}},
 serve:fn=>handler=fn, fetch:async()=>Response.json({id:'alice'}),
 createClient:()=>({from:table=>chain({data:table==='note'?note:{bucket:'meeting-recordings',storage_path:'bob/private.webm'},error:null}),storage:{from:bucket=>({createSignedUrl:async(path,ttl)=>{signed.push({bucket,path,ttl});return {data:{signedUrl:'https://mock.invalid/signed'},error:null}}})}})
 });
 vm.runInContext(ts.transpileModule(edge,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 const request=()=>new Request('https://mock.invalid/audio',{method:'POST',headers:{'x-ms-access-token':'fake-ms-token','Content-Type':'application/json'},body:JSON.stringify({noteId:'owned-note'})});
 let response=await handler(request());assert.equal(response.status,200);assert.equal(signed[0].path,'bob/private.webm');
 console.log('PASS audio-file-reference: Alice-owned note produced signed URL for Bob file');
 note={...note,audio_file_id:null,audio_file:'https://untrusted.invalid/storage/v1/object/public/other-private/bob/secret'};
 response=await handler(request());assert.equal(response.status,200);assert.equal(signed[1].bucket,'other-private');
 console.log('PASS legacy-audio-path: arbitrary URL bucket/path signed with service role');
 note={...note,user_id:'bob',projects:['shared-project'],audio_file_id:'bob-file'};
 response=await handler(request());assert.equal(response.status,403);
 console.log('PASS project-sharing: project-only member rejected before project lookup');
 // Real job admission function, simultaneous absent lookups.
 let jobs=[],runs=[];
 const admission=extracted('workflow-server/src/index.ts',['createSummarizeJob','getMicrosoftUserId','getBearerToken'],{
 fetch:async()=>Response.json({id:'outside-org-user'}),readBody:async()=>({userId:'outside-org-user',noteId:'same-note',summaryRulesOverride:'custom'}),parseSummarizeInput:b=>b,
 supabase:{from:()=>({select:()=>chain({data:null,error:null}),insert:payload=>{const id='job-'+(jobs.length+1);jobs.push(payload);return chain({data:{id},error:null})}})},
 processSummarizeJob:async(id,input)=>runs.push(id),sendJson:()=>{}
 });
 await Promise.all([admission.createSummarizeJob({headers:{authorization:'Bearer fake'}},{}),admission.createSummarizeJob({headers:{authorization:'Bearer fake'}},{})]);
 assert.equal(jobs.length,2);assert.equal(runs.length,2);
 console.log('PASS concurrent-job-create: 2 jobs and 2 pipeline launches for same user/note');
 console.log('PASS organization-gate: Graph-valid outside-org identity admitted without organization check');
 // Real worker and status update, force every terminal DB write to fail.
 let incident=0,attempts=0;const results=new Map();
 const worker=extracted('workflow-server/src/index.ts',['processSummarizeJob','updateWorkflowJob'],{
 setInterval:()=>1,clearInterval:()=>{},JOB_HEARTBEAT_INTERVAL_MS:60000,delay:async()=>{},
 supabase:{from:()=>({update:()=>({eq:async()=>{attempts++;return {error:{message:'mock DB unavailable'}}}})})},
 runSummarizeAudio:async()=>({summary:'saved-note',transcript:[]}),finalizeNoteMemory:async()=>{},completedJobResults:results,raiseIncident:()=>incident++
 });
 await worker.processSummarizeJob('job',{});assert.equal(attempts,5);assert.equal(incident,0);assert.equal(results.has('job'),true);
 console.log('PASS terminal-write-failure: 5 failed DB writes ignored; success cached; no incident');
 // Real orphan sweep, row completes between read and write.
 let state='processing';
 const sweep=extracted('workflow-server/src/index.ts',['failOrphanedJobs'],{env:{supabaseUrl:'mock',serviceRoleKey:'fake'},ORPHANED_JOB_THRESHOLD_MS:300000,
 supabase:{from:()=>({select:()=>{const q=chain(()=>{state='completed';return {data:[{id:'job'}],error:null}});return q;},update:patch=>({in:async()=>{state=patch.status;return {error:null}}})})}});
 await sweep.failOrphanedJobs();assert.equal(state,'failed');console.log('PASS orphan-race: completed row overwritten to failed after stale scan');
 // Real memory fold with deterministic LLM outputs and in-memory DB.
 let memoryRow={memory:{version:2,items:[{id:'prior',text:'prior fact'}]},processed_note_ids:['prior-note']};let readError=false;
 const fold=extracted('workflow-server/src/memory.ts',['foldNoteIntoMemory'],{
 PROCESSED_CAP:500,CONSOLIDATION_ENABLED:false,
 computeMemoryFold:async({priorMemory,noteId})=>({items:[...priorMemory.items,{id:noteId,text:noteId}]}),
 extractInsight:async()=>({insight:{}}),writeNoteInsight:async()=>true
 });
 const db={from:()=>({select:()=>chain(()=>readError?{data:null,error:{message:'read failed'}}:{data:structuredClone(memoryRow),error:null}),upsert:async row=>{memoryRow=structuredClone(row);return {error:null}}})};
 const base={supabase:db,apiKey:'fake',userId:'alice',transcript:'meeting',selfName:null};
 await Promise.all([fold.foldNoteIntoMemory({...base,noteId:'n1'}),fold.foldNoteIntoMemory({...base,noteId:'n2'})]);
 assert.equal(memoryRow.memory.items.length,2);assert.equal(memoryRow.processed_note_ids.length,2);
 console.log('PASS concurrent-memory-fold: one of two new notes lost; final IDs='+memoryRow.processed_note_ids.join(','));
 readError=true;await fold.foldNoteIntoMemory({...base,noteId:'n3'});assert.equal(memoryRow.memory.items.length,1);assert.deepEqual(Array.from(memoryRow.processed_note_ids),['n3']);
 console.log('PASS memory-read-error: prior facts and processed IDs overwritten by new note');
 // Real regenerate function forwards caller identity to fold even when note owner differs.
 let foldedUser;let memoryUser;
 const regen=extracted('workflow-server/src/index.ts',['regenerateSummary'],{
 getMicrosoftUserId:async()=> 'bob',getBearerToken:()=> 'fake',readBody:async()=>({}),parseRegenerateSummaryInput:()=>({noteId:'alice-note',segments:[],speakerProfiles:[],instructions:''}),
 supabase:{from:()=>({select:()=>chain({data:{id:'alice-note',user_id:'alice',shared_users:['bob']},error:null}),update:()=>chain({error:null})})},env:{geminiApiKey:'fake'},resolveRegenerateSummaryRules:async()=> 'rules',
 getPersonalMemoryContext:async user=>{memoryUser=user;return 'private-memory'},callGeminiWithFallback:async()=>({text:'{}'}),buildRegenerateSummaryPrompt:()=>'',formatTranscriptText:()=> 'transcript',parseSummary:()=>({summary:'summary'}),recordGeminiUsage:async()=>{},sendJson:()=>{},foldNoteIntoMemory:async input=>{foldedUser=input.userId}
 });
 await regen.regenerateSummary({},{});assert.equal(memoryUser,'alice');assert.equal(foldedUser,'bob');
 console.log('PASS shared-regenerate: owner memory read as Alice; fold/write identity is Bob');
})().catch(e=>{console.error(e);process.exitCode=1});

```

### Recorder / Auth

```javascript
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root='C:/Users/andre/Projects/meeting-note/';const ts=require(root+'node_modules/typescript');
(async()=>{
 const source=fs.readFileSync(root+'src/context/RecorderContext.tsx','utf8');const ast=ts.createSourceFile('recorder.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let declaration;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='finalizeRecording')declaration=n;ts.forEachChild(n,visit)}visit(ast);assert.ok(declaration);
 let output;const ctx={Blob,URL:{createObjectURL:()=> 'mock:blob',revokeObjectURL:()=>{}},useCallback:fn=>fn,
 recordingSessionRef:{current:{id:'session',mimeType:'audio/webm'}},audioChunksRef:{current:[new Blob(['A']),new Blob(['B'])]},recordedSessionRef:{current:null},chunkIndexRef:{current:2},recordingIntervalRef:{current:null},streamRef:{current:null},recordingLockReleaseRef:{current:null},stopResolveRef:{current:null},
 getChunks:async()=>[new Blob(['A'])],recordedMimeType:'audio/webm',recordedFileName:'audio.webm',setRecordedAudioUrl:()=>{},setRecordedBlob:b=>output=b,setRecordedMimeType:()=>{},setRecordedFileName:()=>{},getAudioBlobDurationSeconds:async()=>null,setRecordingTime:()=>{},setRecoverableSession:()=>{},setIsRecording:()=>{},releaseScreenWakeLock:async()=>{}};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule('const '+declaration.getText(ast)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 await vm.runInContext('finalizeRecording()',ctx);assert.equal(await output.text(),'A');assert.equal(ctx.audioChunksRef.current.length,0);
 console.log('PASS recording-partial-store: persisted A preferred to complete in-memory AB; output A; memory cleared');
 const auth=fs.readFileSync(root+'src/config/supabaseConfig.ts','utf8');const authAst=ts.createSourceFile('auth.ts',auth,ts.ScriptTarget.Latest,true);
 const funcs=authAst.statements.filter(n=>n.name&&['waitForSupabaseAccessTokenProvider','getSupabaseAccessTokenForRequest'].includes(n.name.text));
 const ac=vm.createContext({exports:{},console,supabaseAccessTokenProvider:null,authResolvedWithoutUser:false,debugSupabaseAuth:false,providerWaiters:new Set(),window:{setTimeout:fn=>{queueMicrotask(fn);return 1},clearTimeout:()=>{}}});
 vm.runInContext(ts.transpileModule(funcs.map(n=>n.getText(authAst)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ac);
 assert.equal(await ac.getSupabaseAccessTokenForRequest(),null);console.log('PASS auth-unresolved: 15-second cap returns null token without logged-out resolution');
})().catch(e=>{console.error(e);process.exitCode=1});

```
