---
title: "AI 에이전트 작업 가이드"
slug: guide-for-ai-agents
section: "Getting started"
order: 2
revision: "2026-10-13.1"
last_verified_commit: "56781a4be253a4edc98f56aaf3a53d14536ac96f"
last_verified_at: "2026-10-13"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# AI 에이전트 작업 가이드

이 문서는 AI 에이전트가 Meeting Note와 함께 일하는 방법을 설명한다.
핵심 원칙은 "문서화가 곧 개발 인터페이스"다.
에이전트는 여기 있는 명세를 먼저 읽고, 그 명세에 맞춰 기능을 생성하거나 유지보수한다.
코드를 짐작으로 고치지 말고, 해당 시스템 문서를 근거로 삼아 그에 맞춰 구현한다.

## 작업 규칙

- 먼저 읽고, 그다음 구현한다. 어떤 시스템을 건드리기 전에 그 시스템의 문서(예: F2는 [f2-feedback](./f2-feedback))를 읽고 거기 적힌 데이터 모델·상태·엔드포인트·제약을 기준으로 작업한다.
- 이 문서들은 실제 코드(마이그레이션, `src/`, `workflow-server/`)에 근거한다. 희망사항이 아니다. 각 문서의 frontmatter `source_of_truth`와 `last_verified_commit`이 근거를 가리킨다.
- 문서와 코드가 어긋나면 코드가 진실이다. 어긋남을 발견하면 문서를 고치고 검증 메타(`revision`, `last_verified_commit`, `last_verified_at`)를 함께 갱신한다.
- 회의에서 나온 제안이나 요청을, 확정된 결정으로 바꿔 말하지 않는다.

## 문서 디스커버리

이 문서 세트는 두 경로로 서빙된다. 둘 다 TecAce 조직 게이트 뒤에 있다.

- 사람: 인증된(MSAL) 웹 `/docs` 페이지.
- 에이전트: Meeting Note MCP 서버.

에이전트가 문서를 찾는 진입점은 MCP 툴 `get_product_docs`다(AXKH의 동명 툴에 대응).
입력은 문서 slug(`product-overview`, `guide-for-ai-agents`, `f2-feedback`, `mcp-connection`, `release-history`)이거나 목록 조회다.
출력은 해당 문서의 마크다운 본문과 메타데이터(revision, last_verified_commit, last_verified_at, source_of_truth)다.
처음 붙는 에이전트는 이 `guide-for-ai-agents`부터 읽고, 필요한 시스템 문서로 이동한다.

문서 slug와 섹션/순서는 매니페스트(`manifest.json`)에 정의돼 있다.
섹션 순서는 Getting started -> Features -> Integrations -> History다.

### 현재 구현 상태 (정직하게)

- `get_product_docs` MCP 툴과 인증된 웹 조회 API(`/product-docs`, `/product-docs/{slug}`)는 **구현 완료, 배포 대기**다(working tree에 반영, 아직 미커밋/미배포). 설계는 `AGENT_DOCS_DESIGN.md`에 있고, 프론트엔드 클라이언트는 `src/lib/productDocs.ts`에 같은 계약으로 연결돼 있다.
- 이 문서들은 서버 콘텐츠(`workflow-server/content/product-docs/`)에 보관되며, 웹 경로와 MCP 경로 모두 동일한 로더(`workflow-server/src/productDocs.ts`)를 호출한다. 프론트 번들에는 본문이 포함되지 않는다.
- 권한검사: 웹 경로는 TecAce 도메인 허용목록(기본 `tecace.com`)으로 조직 구성원을 확인한 뒤 응답한다. MCP 경로는 org-verified 호출자(정적 키 또는 개인 토큰)만 `get_product_docs`를 쓸 수 있고, 익명/그래프 fallback 호출자는 문서 조회에서 차단된다.

### 자동갱신 훅은 아직 배선되지 않음

이 문서들은 지금 코드로부터 손으로 검증해 작성한다(hand-verified).
코드에서 `.md`와 매니페스트를 재생성하는 결정적 생성기 + prebuild/CI 훅은 설계상 자리만 남겨뒀고 아직 배선하지 않았다.
`scripts/ai-native-docs/generate.mjs`와 `scripts/gen-version.cjs` 옆에 붙이는 것이 자연스러운 연결점이다.
자동 생성이 들어오면 "생성됨"과 "검증됨"을 반드시 분리해야 하며, `last_verified_*`는 실제 검증 시에만 갱신한다.

## MCP가 노출하는 것 (실제 툴 이름)

MCP 서버 이름은 `meeting-note`다(`workflow-server/src/mcp/server.ts`).
현재 등록된 툴은 다음과 같다. 모두 호출자의 스코프 사용자로 접근 제한되며(소유 + 공유 노트), 날짜 필터는 KST 기준이다.

노트 / 전사 (`tools/notes.ts`):
- `list_recent_notes` - 접근 가능한 최근 노트 메타데이터(태그·프로젝트 포함).
- `list_personal_notes` - 본인 소유 노트만.
- `list_shared_notes` - 다른 소유자가 공유한 노트만.
- `get_shared_notes_by_owner` - 소유자 이름으로 공유 노트 찾기(퍼지 매칭, 200개 스캔 상한 신호 포함).
- `search_notes` - 제목·요약·전사 + 구조화 인덱스(people/topics/companies)에 대한 랭킹 하이브리드 검색. note_insight 기반.
- `get_notes_by_date` / `get_summaries_by_date` / `get_transcripts_by_date` - 단일 날짜 또는 기간으로 조회.
- `get_note` - 한 노트의 메타데이터와 가용성 플래그.
- `get_note_summary` - 편집본 우선, 없으면 생성 요약.
- `get_note_transcript` - plain 또는 diarized 전사.
- `get_note_speaker_segments` - 한 노트 안에서 특정 화자들의 세그먼트.
- `get_speaker_segments` - 화자 이름으로 세그먼트 검색(단일 노트 또는 접근 가능 노트 전체, 노트/세그먼트 상한 신호 포함).

컨텍스트 / 프로젝트 (`tools/context.ts`, `tools/projects.ts`):
- `get_meeting_brief` - 메타데이터·요약·(옵션)전사 발췌·화자·첨부 메타를 담은 단일 회의 패키지.
- `get_attachment_context` - 첨부 메타데이터(파일 내용 다운로드 아님).
- `get_project_timeline` - 프로젝트 관련 회의를 시간순으로.
- `find_action_items` - note_insight 인덱스(owner/due/status) 우선, 미인덱스 노트는 요약 텍스트 휴리스틱 fallback.
- `find_events` - note_insight.events의 cause->effect 쌍(휴리스틱 fallback 없음).
- `list_projects` / `get_project_context` - 프로젝트 목록·컨텍스트. 소유하지 않은 프로젝트의 노트 수는 접근 가능분만 노출(누수 방지).
- `add_note_to_project` / `remove_note_from_project` - 유일한 WRITE 툴. 본인 프로젝트에 접근 가능 노트를 넣고/뺀다. 멱등. service_role RPC가 소유권 재검증.

화자 (`tools/speakers.ts`):
- `list_speakers` - 저장된 화자와 프로필 보유 여부.
- `get_speaker_profile` - id 또는 정확한 이름으로 화자 프로필/온톨로지 조회.

개인 메모리 (`tools/memory.ts`):
- `recall_personal_context` - 로그인 사용자 자신의 누적 개인 메모리(진행 프로젝트·협업자·본인 미결 커밋먼트·과거 결정 이유). 폭넓은 "요즘 뭐 했지" 질문용. 엄격히 본인 전용.
- `search_personal_context` - 특정 엔티티/토픽으로 개인 메모리를 좁혀 검색. 결정적 키워드/엔티티 필터.

평가 (`tools/evaluation.ts`):
- `log_final_answer` - 선택 사항. 최종 사용자 응답 품질 평가를 위해 최종 답을 기록.

OpenAI 호환 (`tools/knowledge.ts`):
- `search` / `fetch` - ChatGPT 지식 소스 호환용 얇은 어댑터. `search`는 `{ query }`로 `{ results: [{ id, title, url }] }`를 반환하고, `fetch`는 `{ id }`로 `{ id, title, text, url, metadata }`를 반환한다. Claude용 주 툴은 위의 `search_notes` / `get_note_*`다.

## 올바른 툴 고르기

- 특정 타인이 한 일(담당자 귀속 사실)은 `find_action_items` / `search_notes`로 찾는다. 개인 메모리 툴로 답하지 않는다.
- 한 회의의 세부는 `get_meeting_brief` / `get_notes_by_date`로 본다.
- 호출자 본인의 여러 회의를 가로지른 이해는 `recall_personal_context`(넓게) 또는 `search_personal_context`(엔티티로 좁혀)로 본다.
- 결과에 `hasMore` / `reachedNoteCap` / `segmentsTruncated` 같은 신호가 있으면 그대로 받아들이고, 잘린 답을 완전한 것처럼 제시하지 않는다.

## 연결 방법

MCP 엔드포인트와 Bearer 토큰 모델은 [mcp-connection](./mcp-connection)에 있다.
