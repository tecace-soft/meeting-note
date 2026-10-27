# AXKH 노드 + 결정 기록 + 원클릭 연동 플랜

작성일: 2026-10-19
상태: 제안 v1 (결정 D1-D4는 사용자 확정, 구현 전).
관련 작업: #5(결정 기록), #12(AXKH 위키 노드), #13(연동 원클릭).
관련 회의: 2026-10-15(AX-KH 위키 노드, 단순 훅 요청), 2026-10-19(위 세 작업을 함께 진행하기로 정리).
선행 문서: `AGENT_DOCS_EXPANSION_PLAN.md`, `workflow-server/src/knowledge/ROLLOUT.md`.

## 1. 배경과 목표

Hansoo는 녹음 후 AXKH로 보내는 절차를 단순하게 만들고, AXKH 쪽 승인 단계를 없애려 한다.
또한 Andrew의 작업물을 AXKH 위키의 "하나의 자동 갱신 노드"로 유지하길 원한다.
Hansoo는 10/20부터 10/30까지 출장이므로, 그 전에 확인할 질문을 §6에 모았다.

목표는 세 가지다.

1. #5: 결정이 AGENTS.md와 여러 `*_DESIGN.md`에 흩어져 있어 에이전트가 모르고 어기는 일이 생긴다. 구조화된 결정 기록과 경고 장치를 만든다.
2. #12: Meeting Note 팀 공용 노드 1개를 AXKH에 "살아있는 문서"로 게시한다.
3. #13: Meeting Note 쪽의 두 단계("연동 설정 만들기", "전송 켜기")를 버튼 하나로 합친다.

## 2. 결정 사항 (사용자 답변, 2026-10-19)

- **D1 (#13)**: 기존 knowledge 파이프라인(outbox, ACK, 접근 검사, 추출)은 그대로 둔다.
  Meeting Note 쪽 두 단계만 한 버튼으로 합친다.
  AXKH 쪽 승인 제거(reference 승인, model-policy 승인)는 Hansoo의 AXKH 저장소에서 별도로 진행한다.
- **D2**: 녹음 후 자동 전송은 하지 않는다.
  녹음/요약이 끝나면 원클릭 버튼을 눈에 띄게 보여주고, 사용자가 누르면 전송한다.
- **D3 (#12)**: 팀 공용 AXKH 노드 1개를 에이전트 세션의 수동 명령으로 갱신한다.
  로컬에서 본문을 조립하고, secret/PII 스캐너를 돌리고, 사용자에게 미리 보여준 뒤, AXKH MCP `add_knowledge`를 "살아있는 문서"로 호출한다.
  (product slug + asOf, 같은 제목이면 같은 문서 갱신, 이전 본문은 이력 보존, 2단계 confirm)
  개인 키는 로컬에만 둔다.
  AXKH 문서상 service key는 생성만 가능하고 갱신은 개인 키가 필요하다.
- **D4 (#5)**: 구조화된 결정 기록 형식을 새로 만들고, 기존 결정을 백필한다.
  (AGENTS.md의 "Identity trust", "Storage RLS owner_id" 같은 규칙, 루트 `*_DESIGN.md`의 핵심 결정)
  변경 파일이 결정의 path glob과 겹치면 CI와 에이전트 규칙에서 권고 경고를 낸다.
  경고만 하고 절대 차단하지 않는다.

## 3. 현황 검증 (코드 확인 결과)

- 웹 버튼 "AXKH 연동"은 `src/pages/SummaryHistory.tsx`에 4곳(약 2717, 3231, 3516, 4034행)에 있고, `MeetingKnowledgeModal`(3691행에서 렌더)을 연다.
- 모달 `src/components/MeetingKnowledgeModal.tsx`에서 `initialize`는 156행, `enable`/`disable`은 159행이다.
  `initialize`만 `expectedAccessRevision` 없이 호출하고, 나머지는 `status.accessRevision`을 넘긴다(110행).
- 클라이언트는 `src/services/meetingKnowledge.ts`이고 `VITE_MEETING_KNOWLEDGE_UI_ENABLED`는 이 파일에서 읽는다.
- **차이 1 (플래그 위치)**: 사용자 요약에는 모달/페이지가 플래그를 읽는 것처럼 되어 있으나, 코드상 플래그는 `meetingKnowledge.ts`에만 있다. 버튼 노출 조건은 구현 시 재확인한다.
- **차이 2 (RPC 호출 주체)**: RPC `meeting_knowledge_initialize` / `meeting_knowledge_mutate`는 브라우저가 아니라 workflow-server가 호출한다.
  브라우저는 `POST ${API_URL}/knowledge/v1/source-access`를 호출하고, `workflow-server/src/knowledge/http.ts`가 action(`initialize`, `enable` 등)을 `store.ts`(114, 155행)의 RPC 호출로 바꾼다.
  따라서 원클릭은 서버 쪽 조합으로 구현할 수 있다.
- RPC 정의는 `supabase/migrations/20261004034140_meeting_knowledge_access_ledger.sql`이다.
  `initialize`는 `on conflict do nothing`이라 멱등이고 현재 revision을 반환한다.
  `mutate`는 `p_expected_access_revision` 불일치 시 `ACCESS_REVISION_CONFLICT`를 던지고, `enable`은 이미 켜져 있으면 `changed=false`라 revision을 올리지 않는다.
- 모바일에는 knowledge 코드가 없다(이 플랜 범위 밖).
- 문서 체계: `docs/ai-native/decision.md`는 산문 항목 1개뿐이다(확인됨).
  `docs/ai-native/history.md`는 더 이상 자동 생성되지 않는다(DEC-0023). 훅은 `intro.md`의 구조 영역만 갱신하고 최근 이력은 git에서 읽는다.
  제품 문서는 `workflow-server/content/product-docs/manifest.json`(`depends_on`, `verified_body_hash`)과 `workflow-server/scripts/product-docs/{verify,generate,check,shared}.ts`로 관리한다.
  CI는 `.github/workflows/product-docs-check.yml`과 `ci.yml`이다.
- 계약 파일(`contract.ts` 등)은 AXKH 저장소와 byte-identical이어야 하므로 이 플랜은 계약 변경을 하지 않는다.

## 4. 작업 순서

### Phase 1: #5 결정 기록 (형식, 백필, 권고 검사)

추가/변경 파일:
- `docs/decisions/README.md` (형식 설명), `docs/decisions/<id>.md` (결정 1건당 1파일, YAML frontmatter + 짧은 본문).
- `scripts/decisions/check.mjs` (Node 내장만 사용): 변경 파일 목록과 각 결정의 `paths` glob을 대조해 경고 출력, 종료 코드는 항상 0.
- `.github/workflows/decisions-advisory.yml` (PR 시 경고를 job summary와 주석으로만 남김, 실패 처리 금지).
- `AGENTS.md`에 한 줄 규칙 추가(변경 전 `docs/decisions/`에서 해당 path 결정 확인).
- `docs/ai-native/decision.md`는 새 기록으로 가는 포인터를 추가한다(기존 산문은 보존).

백필 대상: AGENTS.md의 "Identity trust", "Storage RLS on upload-then-record buckets"와 그 외 규칙, 루트 `*_DESIGN.md`의 핵심 결정.
`source` 필드에 원문 위치를 적고, 불확실한 것은 `status: needs-review`로 둔다(추정으로 채우지 않는다).

테스트: check 스크립트 단위 테스트(glob 일치, 불일치, 삭제/이름변경 파일, 결정 파일 자체 frontmatter 검증, 항상 exit 0).
완료 기준: 백필 결정 최소 10건 이상, 스키마 검증 통과, 의도적 위반 PR에서 경고가 보이고 머지는 막히지 않음.
E2E: 테스트 브랜치에서 `workflow-server/src/auth` 또는 해당 glob 파일을 수정해 로컬과 CI 양쪽 경고를 확인한다.

### Phase 2: #12 노드 조립기 + 첫 게시

추가/변경 파일:
- `scripts/axkh-node/sources.json`: 소스 allowlist(파일 경로 + 섹션 단위). 기본값은 "포함 안 함"이고 전체 파일을 통째로 넣지 않는다.
  포함 후보: `docs/decisions/*`(Phase 1 산출물), `docs/ai-native/intro.md`, 제품 문서 공개 본문, AGENTS.md의 아키텍처/명령 섹션.
  제외: RUNBOOK 5절과 7절, `docs/reviews/*`, 사고 기록, env 구조.
- `scripts/axkh-node/assemble.mjs`: allowlist로 본문 조립, 출력은 로컬 파일(커밋 금지, gitignore).
- `scripts/axkh-node/scan.mjs`: 스캐너. 탐지 대상은 내부 URL/호스트, 이메일, UUID(tenant/oid/project ref), env 변수 이름과 값 구조, API 키 패턴, 사고 서술 키워드.
  하나라도 걸리면 게시 단계로 진행하지 않는다(사용자가 항목별로 제거 또는 명시 허용).
- `.claude/commands/publish-axkh-node.md`: 수동 명령. 순서는 조립, 스캔, 미리보기 표시, 사용자 승인, `add_knowledge`(product slug + asOf, 1단계 확인 질문을 사용자에게 그대로 전달, 승인 후 `confirm:true`).
- 개인 키는 로컬 환경에서만 읽고 저장소와 노드 본문에 넣지 않는다.

테스트: 스캐너 단위 테스트(각 카테고리별 양성/음성 샘플), 조립기가 allowlist 밖 파일을 읽지 않는지 검증, 같은 입력이면 같은 출력(멱등).
완료 기준: 스캐너 통과 본문이 AXKH에 게시되고, 두 번째 게시가 새 노드가 아니라 같은 문서 갱신 + 이력 보존으로 나타난다.
E2E: 첫 게시 후 AXKH `search_nodes`로 노드가 검색되는지 확인하고, 본문을 한 줄 바꿔 재게시해 이력을 확인한다. 결과를 Hansoo에게 보고한다(출장 전 가능하면).

### Phase 3: #13 원클릭 연동 + 눈에 띄는 버튼

방식 결정 (두 안 비교):

- **안 A: 새 단일 RPC(원자적)**. initialize와 enable을 한 트랜잭션으로 수행.
  장점은 중간 상태가 없다는 것이다.
  단점은 마이그레이션이 필요하고(이 프로젝트는 prod DB 마이그레이션 드리프트 이력이 있음), 계약/ledger SQL 하네스 영향 범위가 커진다.
- **안 B: 서버에서 순차 호출**. `http.ts`에 새 action(예: `enable_all`)을 두고 `store.ts`가 `initialize`의 반환 revision으로 `mutate('enable')`을 이어서 호출.
  클라이언트는 한 번만 요청한다.

**권고: 안 B.**
- 낙관적 락: initialize가 현재 `accessRevision`을 돌려주므로 서버가 그 값을 바로 enable에 쓴다.
  브라우저에서 두 번 왕복하며 revision이 낡을 일이 없고, 충돌 시 `ACCESS_REVISION_CONFLICT`는 그대로 전달해 한 번만 상태 재조회 후 재시도한다.
- 멱등성: initialize는 `on conflict do nothing`, enable은 이미 켜져 있으면 no-op이라 재시도해도 안전하다.
- 부분 실패: initialize 성공 후 enable 실패 시 상태는 "설정 있음, 전송 꺼짐"이고 이는 현재 UI가 이미 허용하는 안전한 상태다(프라이버시 측면에서 실패 시 켜진 채 남지 않음).
  응답에 어느 단계까지 성공했는지 담아 UI가 "전송 켜기"만 다시 보여주게 한다.
- 규칙 준수: 재시도는 상한(최대 1회 충돌 재시도), 기존 store의 타임아웃을 그대로 사용, 오류를 삼키지 않고 에러 코드를 UI까지 전달한다.
- 계약 영향: 새 action은 `http.ts` 관리 명령에만 추가한다. `contract.ts`는 건드리지 않는다(구현 전 `http.ts` 명령 타입이 계약 파일 소속이 아님을 diff로 재확인).
- 마이그레이션이 없어 롤백과 배포가 단순하다.

변경 파일:
- `workflow-server/src/knowledge/http.ts`, `store.ts` (+ 각 `*.test.ts`): `enable_all` action.
- `src/services/meetingKnowledge.ts`: `MeetingKnowledgeAction`에 추가.
- `src/components/MeetingKnowledgeModal.tsx`: 미설정 상태에서 "연동하고 전송 켜기" 단일 버튼. 성공 후 참석 확인을 후속 선택 항목으로 안내(참석 확인은 선택 사항 유지).
- `src/pages/SummaryHistory.tsx`: 요약 완료 직후 소유자에게 버튼을 눈에 띄게 노출(자동 전송 없음, D2). 기존 4개 진입점과 동일한 플래그/소유자 조건을 사용.

테스트: `store`/`http` 단위 테스트(정상, initialize 성공 후 enable 실패, revision 충돌 1회 재시도, 이미 활성, 비소유자 거부), 프런트 컴포넌트 테스트(버튼 상태, 부분 실패 문구).
완료 기준: 미설정 노트에서 클릭 1회로 `integration_enabled=true`가 되고, 자동 전송 경로가 존재하지 않음을 코드 검색으로 확인.
E2E: 실제 계정으로 새 요약 후 버튼 1회 클릭, outbox 전달과 ACK, AXKH 검색 결과까지 확인한다. 이어서 실패 주입 후 재클릭 시 정상 수렴하는지 확인한다.

## 5. 작업 간 의존

- Phase 2의 노드 소스에 Phase 1 결정 기록이 들어가므로 순서는 1, 2, 3이다.
- Phase 3은 독립적이라 Phase 2와 병행 가능하지만, 보고 일정(Hansoo 출장 전)상 Phase 2 첫 게시를 우선한다.

## 6. 위험과 미해결 질문

위험:
- 승인 제거 후에는 Meeting Note의 노트별 opt-in(`integration_enabled` 기본 꺼짐)과 참석자/공유 권한이 유일한 방어선이다. D2(자동 전송 금지)가 이를 지킨다.
- 노드 본문 유출: 스캐너는 완벽하지 않으므로 allowlist 우선, 미리보기 사용자 확인을 반드시 거친다.
- 개인 키가 필요한 갱신은 사람이 있는 세션에서만 가능하다(자동화 불가, 의도된 제약).
- 결정 백필은 해석이 들어간다. 원문 위치(`source`)를 남기고 불확실한 것은 `needs-review`로 표시한다.
- 경고 피로: glob이 너무 넓으면 무시된다. 결정마다 좁게 쓴다.

Hansoo 출장(10/20-10/30) 전에 확인할 것:
1. AXKH 쪽 승인 제거(reference 승인, model-policy 승인)의 시점. 제거 전에 원클릭을 켜면 기존 승인 대기 흐름과 어떻게 만나는가.
2. model-policy 승인 없이도 외부 Gemini 추출을 계속 허용해도 되는가. 허용되지 않으면 추출 단계를 어떻게 둘 것인가.
3. Meeting Note 노드의 product slug와 보안 등급(기본 제안 S2).
4. 노드를 게시할 개인 키 소유자(Andrew 단독인지).

## 7. 결정 기록 스키마 (제안)

파일: `docs/decisions/<id>.md`, YAML frontmatter 후 짧은 본문.

| 필드 | 설명 |
| :--- | :--- |
| `id` | 고유 식별자 (`DEC-0001` 형태) |
| `date` | 결정일 (YYYY-MM-DD) |
| `status` | `active` / `superseded` / `needs-review` |
| `question` | 무엇을 정해야 했는가 |
| `options` | 검토한 대안 목록 |
| `chosen` | 선택한 안 |
| `reason` | 이유 (짧게) |
| `paths` | 영향 받는 파일 glob 목록 (경고 대상) |
| `supersedes` | 대체한 결정 id (없으면 빈 목록) |
| `source` | 원문 위치 (AGENTS.md, 설계 문서, 회의 등) |

작성 예 (Identity trust):

```yaml
id: DEC-0001
date: 2026-10-19   # 백필 시점. 원 결정일이 불명이면 source에 명시
status: active
question: 사용자 인가의 기준을 무엇으로 삼을 것인가
options:
  - 이메일 또는 이메일 도메인
  - Microsoft tenant id(tid) + object id(sub / Graph id)
chosen: tenant id allowlist(ALLOWED_MS_TENANT_IDS) + object id
reason: Entra 테넌트 관리자는 mail 값을 본인 소유가 아닌 주소로 설정할 수 있어 이메일은 신뢰할 수 없다. 이메일은 표시용 데이터다.
paths:
  - workflow-server/src/auth/**
  - workflow-server/src/knowledge/identity.ts
  - src/services/auth*
supersedes: []
source: AGENTS.md "Identity trust", 커밋 af6635d
```

주: `paths`의 실제 glob은 구현 시 코드 검색으로 확정한다(위 값은 예시이며 미검증).
