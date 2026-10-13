---
title: "피드백/이슈 트래커 (F2)"
slug: f2-feedback
section: "Features"
order: 1
revision: "2026-10-13.1"
last_verified_commit: "56781a4be253a4edc98f56aaf3a53d14536ac96f"
last_verified_at: "2026-10-13"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 피드백/이슈 트래커 (F2)

사내 팀 전체가 쓰는 이슈 보드("미니 Jira")다.
인증된 사용자 누구나 피드백을 등록·분류(triage)·해결할 수 있다.
내부용이며 공유 보드다. 이슈에는 사용자별 프라이버시가 없고 팀 전체가 하나의 보드를 본다.
접근 제어는 DB의 행별 규칙이 아니라 앱 레이어(Azure MSAL SSO + `supabase-token` 엣지 함수의 테넌트/도메인 허용목록)에 있다.

## 목적

- 실행 중인 앱 안에서 버그 리포트·기능 요청·질문을 스크린샷과 함께 수집한다.
- 각 제출을 자동 분류(purpose, area, priority, severity)해서 사전 분류된 상태로 들어오게 한다.
- 분류자가 담당자를 지정하고, AI 해결안(근본원인 가설, 확인 항목, 수정 계획, 검증)을 뽑고, 이메일로 알린다.
- F9 자율 운영 에이전트가 운영 인시던트를 올리는 공유 티켓 보드 역할을 한다.

## 데이터 모델

테이블 하나 `public.feedback_issues`와 비공개 스토리지 버킷 하나 `feedback-attachments`.
마이그레이션이 테이블·버킷·RLS 정책을 하나의 단위로 배포해, 반쯤 적용된 상태가 생기지 않는다.

### 테이블 `public.feedback_issues`

| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` 기본값. |
| `issue_key` | text, unique | `FB-YYYYMMDD-<8 hex>`, 클라이언트 생성(아래 Issue key). |
| `title` | text, not null | |
| `description` | text, not null | |
| `purpose` | text, 기본 `other` | `bug` \| `feature` \| `question` \| `other`. |
| `area` | text, 기본 `general` | 앱 화면/영역(아래 Areas). |
| `status` | text, 기본 `OPEN` | `OPEN` \| `TRIAGE` \| `IN_PROGRESS` \| `DONE` \| `CLOSED`. |
| `priority` | text, 기본 `P3` | `P1` .. `P4`. |
| `severity` | text, 기본 `Medium` | `Low` \| `Medium` \| `High` \| `Critical`. |
| `assignee_email` / `assignee_name` | text, nullable | |
| `triage_note` | text, nullable | |
| `ai_suggestion` | jsonb, nullable | 생성 시점에 캡처한 규칙 기반 자동 분류 결과(표시용). |
| `attachments` | jsonb, 기본 `[]` | `{ name, path, type }` 배열. |
| `resolution` | jsonb, nullable | LLM 해결안 객체(아래 Resolution). |
| `resolution_generated_at` | timestamptz, nullable | |
| `resolution_model` | text, nullable | 해결안을 만든 모델 id. |
| `author_email` | text, not null | |
| `author_name` | text, nullable | |
| `triaged_at` | timestamptz, nullable | null이면 "분류 필요". |
| `triaged_by` | text, nullable | |
| `created_at` | timestamptz, not null | `now()` 기본값. |
| `updated_at` | timestamptz, not null | `trg_feedback_issues_updated_at` 트리거가 유지. |
| `deleted_at` | timestamptz, nullable | 소프트 삭제. null이면 활성. |

인덱스: 활성(`deleted_at is null`), `created_at desc`, `status`, `assignee_email`.

### 스토리지 버킷 `feedback-attachments`

비공개(서명 URL만, 스크린샷에 민감한 UI가 담길 수 있음), 파일당 10MB.
허용 타입: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`.
오브젝트 경로는 `<userId>/<uuid>.<ext>`.

### RLS

테이블에 RLS가 켜져 있고, 공유 보드라서 `authenticated` 역할에 select / insert / update가 의도적으로 열려 있다.
service role은 전체 접근(workflow-server의 이메일·해결안 헬퍼가 RLS를 우회).
삭제는 소프트 삭제(`deleted_at` 업데이트)이며 작성자 본인만 가능. 앱 레이어에서 강제한다.
첨부 읽기는 인증 사용자 누구나, 쓰기/삭제는 본인 id 접두 폴더로 제한(`(storage.foldername(name))[1] = auth.jwt() ->> 'sub'`).

## Issue key

클라이언트 생성, 형식 `FB-YYYYMMDD-<8 대문자 hex>`, 예: `FB-20260812-9DC24392`.
랜덤 접미는 `crypto.getRandomValues`에서 뽑은 4바이트.
F9 운영 티켓도 같은 형태에 운영 마커를 붙여 쓴다.

## 상태와 흐름

```
OPEN -> TRIAGE -> IN_PROGRESS -> DONE -> CLOSED
```

- 새 이슈는 `OPEN`, `triaged_at = null`(분류 필요)로 생성된다.
- 분류자가 담당자/우선순위/심각도/상태/분류 노트를 설정한다. `triagedBy`를 넣으면 `triaged_at = now()`가 찍힌다.
- 상태 이동은 자유롭다. 위 순서는 의도된 라이프사이클이지 엄격한 상태 머신은 아니다.
- "Open" KPI는 `DONE`/`CLOSED`가 아닌 것, "Triage" KPI는 `triaged_at`이 없는 것, "Mine" KPI는 현재 사용자에게 배정된 것을 센다.

## 자동 분류 (결정적, LLM 없음)

`src/lib/feedbackIssues.ts`의 `suggestTriage(title, description)`가 제출 시점에 돈다.
순수 규칙 기반이다(한/영 텍스트에 대한 키워드 정규식, 네트워크 호출 없음).

- 첫 매칭 규칙으로 purpose/priority/severity 결정:
  - bug (P2 / High): 에러, 오류, 크래시, crash, 실패, fail, 버그, bug, 깨짐, 튕김, 먹통, 작동, 안 됨 등.
  - feature (P3 / Medium): 추가, 개선, 요청, 기능, feature, 지원 등.
  - question (P4 / Low): `?`, 문의, 어떻게, 질문, how, 왜 등.
  - 그 외 `other` (P4 / Low).
- area는 영역별 동의어 목록으로 탐지. 기본 `general`.
- 에스컬레이션: 긴급어(긴급, 급함, urgent, critical, 심각, 중요 등)에 매칭되면 priority와 severity가 각각 한 단계씩 올라간다.
- 결과는 제출자에게 제안으로 보여주고 `ai_suggestion`에 저장. 사람이 저장 전에 아무 필드나 덮어쓸 수 있다.

## Areas

`meeting-note`(회의 노트) · `history`(히스토리) · `projects`(프로젝트) · `onedrive`(OneDrive) · `settings`(설정) · `speaker`(화자) · `general`(일반).
각 영역은 자동 분류 영역 탐지기가 쓰는 동의어를 갖는다.

## AI 해결안

workflow-server의 `POST /issue-resolution`이 분류자를 위한 실행 가능한 한국어 해결안 초안을 만든다.
호출자를 인증한 뒤(조직 사용자 누구나 분류 가능), 고정 JSON 스키마(`ISSUE_RESOLUTION_SCHEMA`)와 설정된 요약 모델(flash 우선 fallback 체인)로 Gemini를 호출한다.
비공개 버킷에서 이미지 첨부 최대 3개를 service role로 받아 인라인으로 넘겨 모델이 스크린샷을 읽게 한다(이미지가 아니거나 8MB 초과 파트는 건너뜀).

해결안 객체(`IssueResolution`):

```json
{
  "summary": "한 줄 판정",
  "rootCauses": ["순위 매긴 가설들, 미검증"],
  "checks": ["담당자가 클릭/쿼리해 확인할 것"],
  "fixPlan": ["어디를 어떤 순서로 건드릴지"],
  "verification": ["'고쳐졌다'가 어떤 모습이어야 하는지"],
  "confidence": "low | medium | high"
}
```

모델 출력이 파싱되지 않으면 엔드포인트는 재시도 메시지와 함께 502를 반환한다(깨진 해결안을 절대 저장하지 않는다).

## 이메일 알림

`POST /issue-notify`가 best-effort HTML 이메일을 보낸다.
`kind: "created"`는 알림 수신자에게, `kind: "assigned"`는 담당자에게 간다.
이메일은 이슈 헤더, 본문, 스크린샷 최대 3장(7일 서명 URL), 있으면 AI 해결안 블록, 그리고 보드로 돌아가는 딥링크 `<frontend>/issues?issue=<issueKey>`를 렌더한다.
클라이언트에서는 fire-and-forget이라 이메일 실패가 이슈 저장을 막지 않는다. 반환은 `{ ok, sent }`.

## UI

라우트 `/issues`(`src/pages/Issues.tsx`), 앱 셸 네비에서 진입. 나머지 앱처럼 MSAL 인증 뒤에 있다.
900px 미만에서 한 컬럼으로 reflow되는 3-pane 보드:

1. 등록 pane: 제목, 설명, 스크린샷 업로드, 실시간 자동 분류 제안, 제출.
2. 목록 pane: 활성 이슈 전부, 최신순, 상태/우선순위 배지, 선택 가능.
3. 분류 pane: 담당자/상태/우선순위/심각도/노트 편집, AI 해결안 생성, 알림 발송, 소프트 삭제(작성자만).

상단 KPI: Open, Needs-triage, Assigned-to-me.
딥링크 `?issue=<issueKey>`(이메일에서 옴)는 목록 로드 후 해당 티켓을 자동 선택한다.
분류 패널은 이슈 id로 키잉된 하나만 마운트돼, 편집 중 초안이 브레이크포인트 간에 중복되지 않는다.

## 클라이언트 API 서피스

전부 `src/lib/feedbackIssues.ts`에 있고, Supabase(RLS) + workflow-server 호출 둘로 동작한다:

- `listIssues()` - 활성 이슈, 최신순.
- `createIssue(input)` - `OPEN`으로 삽입, 행 반환.
- `updateIssue(id, patch)` - 분류 패치(status/priority/severity/assignee/note/resolution). `triagedBy`가 `triaged_at`을 찍는다.
- `softDeleteIssue(issue, currentEmail)` - 작성자 전용, `deleted_at` 설정.
- `uploadIssueAttachment / deleteIssueAttachment / signAttachmentUrls` - 비공개 버킷 + 온디맨드 1시간 서명 URL.
- `generateIssueResolution(issue, getAccessToken)` - `/issue-resolution` 호출.
- `notifyIssue(kind, issue, getAccessToken)` - `/issue-notify` 호출, 절대 throw하지 않음.
- `suggestTriage(title, description)` - 위의 결정적 분류기.

## 엔드포인트

| 메서드 | 경로 | 서버 | 목적 |
| --- | --- | --- | --- |
| POST | `/issue-resolution` | workflow-server | 이슈 + 스크린샷 최대 3장으로 AI 해결안 초안. |
| POST | `/issue-notify` | workflow-server | created/assigned 이메일(딥링크 포함) 발송. |

이슈 CRUD 자체는 workflow-server가 아니라 클라이언트에서 RLS 아래 Supabase(`feedback_issues`)에 직접 한다.

## F9(운영 에이전트)와의 관계

F9 자율 운영 에이전트가 이 보드를 재사용한다.
워크플로 알림을 근본원인 초안(같은 `ISSUE_RESOLUTION_SCHEMA` 경로)으로 바꿔, 실패 지문으로 디듀프된 운영 태그 티켓을 `feedback_issues`에 올리고 on-call에 이메일한다.
F9은 프로덕션 코드를 절대 쓰지 않는다. 수정은 사람의 몫이다.
F9이 어디에 위치하는지는 [product-overview](./product-overview) 참고.
