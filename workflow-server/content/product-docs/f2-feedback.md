---
title: "피드백/이슈 트래커 (F2)"
slug: f2-feedback
section: "Features"
order: 1
revision: "2026-10-20.1"
source_of_truth: "repo code (AX-KH feedback-porting spec port, 2026-10-14); prod not yet verified"
---

# 피드백/이슈 트래커 (F2)

로그인한 사용자가 앱 안에서 버그 · 개선 요청 · 질문을 등록하고, 관리자가 분류 · 배정하고, 처리 결과가 등록자에게 메일로 돌아가는 미니 이슈 트래커다.
2026-10-14에 AX-KH 의 이식 명세(`docs/feedback-issues-porting-prompt.md`, TecAce Revenue Strategy v0.32.0 기준)대로 다시 만들었다.
명세와 달라진 점은 이 문서 끝의 "기준 명세와 다른 점"에 모았다.

## 권한 (3단계, 역할은 2개)

| 기능 키 | 누가 | 할 수 있는 일 |
| --- | --- | --- |
| `issues` | 로그인한 사용자 전원 | 목록 · 상세 읽기, 등록, 첨부 업로드, 본인 이슈 삭제 |
| `issues.triage` | 관리자 | 분류 저장(종류 · 화면 · 긴급도 · 상태 · 담당자 · 처리 메모), AI 해결책 생성과 저장 |
| `issues.notify` | 관리자 | 신규 이슈 알림 수신자 추가 · 제외 |

관리자는 Microsoft object id 2개(Hansoo Lee, Andrew Yoo)다.
같은 규칙이 세 곳에 있고 서로를 주석으로 가리킨다.
DB 는 `public.feedback_issues_can(key)`, 서버는 `workflow-server/src/issues.ts` 의 `canIssue`, 화면은 `src/lib/issues/permissions.ts` 의 `canIssue` 다.
id 목록 원본은 `src/lib/adminAccess.ts` 이다.
화면에서 숨기는 것은 편의일 뿐이고, 실제 판정은 DB(RLS, 트리거, RPC)와 workflow-server 가 한다.
2026-10-14 이전에는 로그인한 누구나 분류 · 배정할 수 있었다.

## 데이터 모델

마이그레이션 `20260812230000_create_feedback_issues.sql`(테이블, 버킷) 위에 `20261014120000_feedback_issues_parity.sql`(권한, 트리거, RPC, 수신자 테이블, 저장소 정책)을 얹는다.
두 번째 파일은 사람이 Supabase SQL Editor 에서 한 번에 실행한다.
머리 주석에 선행 조건, 사전 확인 쿼리, 되돌리기 블록, 배포 순서가 있다.

### 테이블 `public.feedback_issues`

| 컬럼 | 비고 |
| --- | --- |
| `id` | uuid PK |
| `issue_key` | unique. 사람이 만든 이슈는 `FB-YYYYMMDD-<8 대문자 hex>`(클라이언트 생성, 충돌하면 3회까지 다시 만듦). F9 운영 티켓은 `OPS-` 접두어 |
| `title`, `description` | 필수. 등록 뒤에는 바꿀 수 없다 |
| `purpose` | `bug` \| `feature` \| `question` \| `other` |
| `area` | 화면. 아래 "화면(영역)" |
| `status` | `OPEN`(접수) \| `IN_PROGRESS`(진행 중) \| `DONE`(완료) \| `CLOSED`(닫힘). 예전 값 `TRIAGE` 는 읽을 때와 다음 쓰기 때 `OPEN` 이 된다 |
| `priority` | `P1`(긴급) .. `P4`(낮음). 사람이 고르는 유일한 중요도 |
| `severity` | 트리거가 priority 에서 계산해 저장(P1 Critical, P2 High, P3 Medium, P4 Low). 화면에 보이지 않는다 |
| `assignee_email`, `assignee_name` | 담당자와 배정 시점 이름 |
| `triage_note` | 처리 메모. 완료 · 닫힘 메일에 들어간다 |
| `ai_suggestion` | 등록 시점의 규칙 기반 자동 분류 결과(표시 전용). F9 행에는 운영 메타데이터가 들어 있어 화면이 제안 카드를 그리지 않는다 |
| `attachments` | `{ name, path, type }` 배열. `path` 가 기준이고 공개 URL 은 저장하지 않는다 |
| `resolution`, `resolution_generated_at`, `resolution_model` | AI 해결책 |
| `author_email`, `author_name` | 트리거가 요청 JWT 의 `email`, `user_metadata.name` 으로 덮어쓴다. 표시용이다 |
| `author_id` | 작성자의 Microsoft 객체 id. 트리거가 JWT `sub`(소문자)로 찍는다. 본인 판정(삭제, 등록 알림)의 기준이다(`20261015120000`). 그 전에 등록돼 백필되지 않은 행과 F9 행은 null |
| `triaged_at`, `triaged_by`, `triaged_by_id` | null 이면 "분류 필요". 트리거가 저장 시각, 요청자 이메일(표시용), 요청자 객체 id 를 찍는다 |
| `created_at`, `updated_at`, `deleted_at` | `deleted_at` 이 있으면 소프트 삭제 |

### 서버가 채우거나 막는 값

- INSERT 정책: `status = 'OPEN'`, 담당자 · 처리 메모 · 분류 · 해결책 · 삭제 값 없음, `FB-` 키 형식일 때만 받는다.
- 사용자 행은 F9 운영 티켓처럼 보일 수 없다(`area = 'ops'` 나 `ai_suggestion.source = 'f9-ops-agent'` 거부). F9 쿼리도 `OPS-` 키만 센다.
- 첨부는 호출한 사람이 직접 올린 객체(`storage.objects.owner_id = sub`)이면서 경로 규칙(`screenshots/` 또는 `<uuid>/` 아래 `[A-Za-z0-9._-]` 파일명)을 지킬 때만 붙일 수 있다. 남의 파일을 "사용 중"으로 묶어 삭제를 막는 것을 막는다.
- INSERT 트리거(사용자 요청일 때): JWT 에 이메일이 없으면 거부한다. 작성자 이메일과 이름은 JWT 값(이름은 없으면 null), `created_at` · `updated_at` 은 `now()` 다.
- UPDATE 정책: 관리자만, 삭제 안 된 행만, `deleted_at` 설정 불가.
- UPDATE 트리거(사용자 요청일 때): `issue_key`, `title`, `description`, 작성자, `ai_suggestion`, `attachments`, `created_at` 은 이전 값으로 고정한다. 분류 저장은 JWT 이메일이 없으면 거부한다. 해결책을 바꾸면 `resolution_generated_at = now()` 이고, 해결책 저장은 `triaged_at` 을 건드리지 않는다.
- 삭제: `soft_delete_feedback_issue(id)` RPC(SECURITY DEFINER). `author_id` 가 요청자 `sub` 와 같을 때만, `deleted_at` 만 설정한다. `author_id` 가 없는 행은 관리자만 지울 수 있다. 여기에는 F9 운영 티켓(작성자 `ops-agent@tecace.com`, `author_id` 항상 null)과 백필되지 않은 예전 행이 포함된다. 그래서 관리자는 F9 티켓을 삭제할 수 있다(2026-10-15 리뷰에서 수용한 변경, 그전에는 아무도 RPC 로 지울 수 없었다). 이메일은 본인 판정에 쓰지 않는다(Graph `mail` 은 그 계정의 테넌트 관리자가 바꿀 수 있다, 2026-10-15 보안 리뷰).
- 읽기 정책은 삭제된 행을 숨기지 않는다. 목록 조회가 `deleted_at is null` 로 거른다.
- service role(workflow-server, F9)은 RLS 를 우회한다.

### `public.issue_notify_recipients`

신규 이슈 알림 수신자 목록이다(`email` PK, 소문자 강제, `added_by`, `added_at`).
읽기는 로그인 사용자, 추가 · 제외는 관리자만 한다.
`added_by` 는 트리거가 요청자로 채운다.
비어 있을 때만 첫 수신자 `andrewyoo@tecace.com` 을 시드한다.
테이블을 읽지 못하면 같은 주소 1명에게 보내고(폴백), 읽었는데 비어 있으면 아무에게도 보내지 않는다.

### 사용자 디렉터리 `list_issue_directory()`

담당자 필터 · 담당자 선택 · 수신자 검색에 쓰는 RPC 다.
`app_user` 중 이메일이 있는 사람의 이메일(소문자), 표시 이름, 관리자 여부를 Microsoft 객체 id 별로 로그인 사용자에게 돌려준다.
같은 이메일을 두 개 이상의 객체 id 가 쓰면, 관리자 id 가 아닌 항목은 숨긴다. 다른 계정이 남의 주소로 이름이나 관리자 표시를 바꾸지 못하게 하기 위해서다.
`app_user` 자체의 RLS 는 그대로(본인 행만) 둔다.
사용자 요청으로 `app_user` 를 쓰면 트리거가 `email` · `display_name` 을 JWT 값으로, `last_seen_at` 을 `now()` 로 덮는다. 그래서 디렉터리에 가짜 이름이나 남의 주소를 심을 수 없다. service role 쓰기는 그대로다.
담당자 선택 목록은 이름 옆에 이메일을 함께 보여 준다.

### 저장소 `feedback-attachments`

비공개, 파일당 10MB, PNG · JPEG · WebP · GIF · BMP · HEIC · HEIF 와 PDF(SVG 는 받지 않는다).
새 업로드 경로는 `screenshots/{Date.now()}-{UUID}.{ext}` 이고, 예전 `<sub>/...` 경로도 계속 읽힌다.
읽기 · 업로드는 로그인 사용자, 삭제는 본인이 올린 파일(`owner_id = sub`)이면서 어느 이슈(삭제된 이슈 포함)에도 붙지 않은 파일만 된다.
화면은 1시간, 메일은 24시간 서명 URL 을 쓴다. 메일에서 이슈로 돌아가는 기본 수단은 딥링크 버튼이다.
AI 해결책은 서버가 `issueKey` 로 이슈 행을 읽고 그 첨부(경로 규칙 통과분, 최대 3장)만 버킷에서 직접 읽어 넘긴다. 요청 본문의 경로는 쓰지 않는다.

## 화면 (`/issues`)

진입은 사이드바 "피드백 / 이슈"와 메일의 딥링크 `/issues?issue=<issueKey>` 두 가지다.
문구는 한국어일 때 명세 §8.4 를 글자 그대로 쓰고, 영어 설정이면 같은 뜻의 영어로 보인다.
자동 분류 근거 문장은 언어 설정과 관계없이 한국어로 저장된다.

- 폭 1536px 이상: 등록 · 목록 · 분류 3단. 분류 패널은 오른쪽에 고정된다.
- 1280 ~ 1535px: 등록 · 목록 2단, 분류는 오른쪽 슬라이드오버(최대 448px).
- 1280px 미만: 상단 전환 탭 `[새 이슈 | 목록 · N]`(N = 미종결 수), 분류는 전체 폭 슬라이드오버.

### 등록

- 제목 · 설명 필수, 종류 버튼 4개, 화면 선택, 첨부(Ctrl+V 는 폼이 보이는 동안 문서 전체에서, 끌어 놓기, [파일 선택]).
- 입력이 500ms 멈추면 `localStorage` 의 `issue_draft_<email>` 에 사용자가 고른 값만 자동 저장한다. 다시 들어오면 "쓰던 내용을 불러왔습니다. [새로 작성]" 배너와 함께 복원한다.
- 종류 · 화면 · 긴급도는 `suggestTriage(title, description, purposeOverride)` 가 그릴 때마다 계산한다. 제목 · 설명이 비면 종류 버튼을 강조하지 않는다.
- 등록에 성공하면 폼 자리에 완료 화면(이슈 번호, 알림 받은 사람, [목록에서 보기] [새 이슈 쓰기])이 뜨고, 새 이슈는 목록에서 초록으로 강조된다. 알림 요청이 실패하면 "알림 메일을 보내지 못했습니다. 처리되면 이 목록에서 확인할 수 있어요." 라고 표시한다.

### 목록

- 보기 탭 4개(미종결 · 분류 필요 · 내 담당 · 전체)와 각 개수. 개수는 검색 · 담당자 필터와 무관하게 전체 기준이다. "분류 필요"가 1 이상이면 그 배지만 호박색이다.
- 검색(제목 · 번호 · 등록자 · 설명), 담당자 필터(모든 담당자 / 미배정 / 디렉터리의 사람).
- 종류별 그룹(버그 → 개선 요청 → 질문 → 기타), 접기 가능, 빈 그룹은 그리지 않는다. 등록 시각 내림차순.

### 분류 패널

- 머리(번호 · 상태 / 제목 / 등록자 · 시각 · 분류한 사람) → 설명 → 첨부 → (권한 없음 안내) → 자동 분류 제안 카드 → 입력 → AI 해결책 → 하단 고정 저장 줄.
- 편집 상태(draft)는 보드에 하나만 있다. 다른 이슈를 고르면 초기화되고, 같은 이슈가 갱신되면 손대지 않았을 때만 새 서버 값으로 바뀐다.
- 저장은 [저장] 또는 Ctrl/Cmd+Enter. 결과는 "저장됨 HH:mm · {담당자}에게 배정 메일 · 등록자에게 처리 알림".
- 관리자가 아니면 입력이 모두 비활성이고 안내 문장이 보인다. 작성자에게만 [삭제]가 보인다.

## 서버 (workflow-server)

| 메서드 | 경로 | 권한 | 하는 일 |
| --- | --- | --- | --- |
| POST | `/issue-resolution` | 관리자 | 제목 · 설명 · 이미지 최대 3장으로 해결책(원인 가설 · 확인 절차 · 수정 방향 · 검증 방법 · 신뢰도)을 만든다. DB 에 쓰지 않는다. POST 외 405, 권한 없음 403, 제목이나 설명이 없으면 400 |
| POST | `/issue-notify` | 아래 | 본문은 `{ kind, issueKey }` 만 본다. 받는 사람과 내용은 서버가 DB 행에서 만든다 |

`/issue-notify` 의 세 가지 kind:

- `created`(N1): 등록자 본인(호출자 객체 id = `author_id`)이 등록 후 15분 안에만 부를 수 있다. 수신자 테이블의 사람들에게 보내고, 확정한 수신자를 먼저 응답한 뒤 백그라운드로 보낸다. 같은 이슈는 한 번만 보낸다(서버 메모리 기준이라 재배포하면 초기화된다). 같은 작성자가 최근 1시간에 10건을 넘게 등록했으면 429 를 돌려주고 메일을 보내지 않는다.
- `assigned`(N2): 관리자만. 현재 담당자가 있고 호출한 사람이 아니면 담당자에게 보낸다.
- `resolved`(N3): 관리자만. 상태가 완료 · 닫힘이고 등록자가 호출한 사람이 아니면 등록자에게 보낸다. F9 시스템 작성자에게는 보내지 않는다.

2026-10-14 이전의 `/issue-notify` 는 클라이언트가 보낸 제목 · 본문 · 담당자 주소로 메일을 보냈다(아무 주소로나 보낼 수 있는 릴레이 위험).
지금은 그 필드를 무시한다.
모바일 앱이 보내는 예전 형식(`kind: 'created'` + 여러 필드)은 그대로 받는다.

메일은 Resend(`sendEmail`)로 서버에서 보낸다.
실패해도 저장은 성공이고 로그만 남는다.
템플릿은 명세 §9 그대로(제목 접두어 `[Issue]` · `[Issue Assigned]` · `[Issue Done]` · `[Issue Closed]`, 공통 5행, 스크린샷 인라인, 딥링크 버튼)이고, 하단 서명은 "Meeting Note 자동 알림"이다.

AI 해결책 모델은 `workflow-server/src/gemini-models.ts` 의 `ISSUE_RESOLUTION_MODEL`(lite, 비용 정책)과 lite 전용 폴백 체인이다.
Gemini 의 JSON 스키마 응답(`responseSchema`)을 쓰고 출력은 엄격히 검사한다(재시도 · 문자열 보정 없음).

## 코드 위치

- 순수 로직: `src/lib/issues/`(`constants`, `triageRules`, `listFilter`, `keys`, `triageDraft`, `mailDecision`, `permissions`, `strings`).
- 데이터 · 서버 호출: `src/lib/issues/service.ts`, `src/lib/issues/serverApi.ts`.
- 화면: `src/pages/Issues.tsx`, `src/components/issues/`.
- 서버 규칙: `workflow-server/src/issues.ts`. 핸들러는 `workflow-server/src/index.ts`.
- 테스트: `src/lib/issues/logic.test.ts`(명세 §12.1 L1~L18), `src/components/issues/IssuesBoard.test.tsx`(화면 동작), `workflow-server/src/issues.test.ts`(권한 · 수신자 · 메일), `supabase/tests/feedback_issues_rls.sql`(RLS 직접 호출, `node workflow-server/scripts/verify-feedback-issues-sql.mjs <pglite 경로>`).

## F9(운영 에이전트)와의 관계

F9 은 service role 로 `OPS-` 키, `area = 'ops'`, RCA 해결책이 채워진 티켓을 올린다.
같은 장애가 반복되면 `ai_suggestion` 의 발생 횟수만 올린다.
화면은 `ops` 를 "운영"으로 보여 주지만 선택 목록에는 넣지 않는다.
작성자가 시스템이라 아무도 삭제할 수 없고, 관리자가 닫는다.

## 기준 명세와 다른 점

- LLM 은 Anthropic 대신 Gemini(lite) 이고, 추론은 끈다(`thinkingBudget: 0`, `docs/API_LESSONS.md`).
- AI 요청은 `imageUrls` 를 받지 않는다. 서버가 `issueKey` 로 이슈 행을 읽어 그 첨부를 비공개 버킷에서 직접 읽는다.
- 메일 스크린샷 서명 URL 은 명세의 30일 대신 24시간이다(보안 리뷰 2026-10-15).
- 첨부 경로의 무작위 부분은 명세의 7자 대신 UUID 다.
- 알림 요청이 실패했을 때의 완료 문구는 명세 §8.4 에 없어 새로 넣었다(명세 C6 문구 재사용).
- 담당자 선택 목록에 이메일을 함께 보인다.
- 버킷 이름은 운영 데이터가 있는 `feedback-attachments` 를 유지한다. 삭제 정책에 `owner_id` 조건을 더했다.
- 딥링크는 `?tab=issues` 대신 `/issues?issue=<key>` 다.
- 역할이 둘뿐이라 '처리 권한' · '알림 수신자 설정 권한'은 '관리자 권한'으로, '로그인 허용 사용자/목록'은 '이 앱의 사용자'로 표기한다.
- 아이콘은 coolicons 에 벌레 · 마법봉이 없어 CircleWarning · Star 로 대신한다.
- 활동 로그와 되돌리기가 없어 LIST-9 와 AI-9 는 빠졌다. 시뮬레이션 모드가 없어 CREATE-14 도 해당 없다.
- 모바일 앱은 이번 범위가 아니다. 모바일은 예전 키워드 규칙으로 분류해서 같은 글이라도 웹과 결과가 다를 수 있다. 등록 · 목록은 새 정책 아래서 그대로 동작한다.
