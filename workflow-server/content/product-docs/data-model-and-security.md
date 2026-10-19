---
title: "데이터 모델과 보안"
slug: data-model-and-security
section: "Getting started"
order: 4
summary: "노트·메모리·화자·이슈 테이블과 RLS, 스토리지 버킷 소유자 스코프, MSAL->Supabase 토큰 교환을 저장소 명세로 정리. 저장소 명세와 운영 적용 상태를 명확히 분리한다."
depends_on:
  - "supabase/migrations/"
  - "supabase/functions/supabase-token/"
  - "supabase/functions/_shared/msGraphAllowlist.ts"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 데이터 모델과 보안

이 문서는 민감하다.
보안 경계를 설명하므로, 무엇이 "코드에 적혀 있는가"와 무엇이 "프로덕션에 실제로 적용돼 있는가"를 섞으면 안 된다.
그래서 두 가지를 명시적으로 분리한다.

- (A) 저장소 명세: `supabase/migrations/*.sql`과 엣지 함수 코드에 정의된 스키마·RLS·권한.
- (B) 운영 확인 상태: 저장소 명세가 프로덕션 DB의 실제 적용이나 수동 정책 변경을 증명하지 않는다는 사실.

이 문서는 기본적으로 (A) 저장소 명세를 기록한다.
어떤 줄이 (B) 운영에서 확인됐다면, 그 줄에 "운영 확인"이라고 명시한다.
토큰·시크릿·키 값은 이 문서에 넣지 않는다.

## (B) 저장소 명세 != 운영 상태 (먼저 읽을 것)

Supabase 마이그레이션은 자동 적용이 아니다.
손으로 적용하므로, 저장소의 `.sql` 파일이 존재한다는 것이 그 정책이 프로덕션 DB에 반영돼 있음을 보장하지 않는다.
반대로, 저장소를 거치지 않고 호스팅 프로젝트에서 직접 만들어진 객체도 있다(아래 참고).
따라서 "이 RLS가 프로덕션에서 실제로 유효한가"는 저장소를 읽는 것으로 답할 수 없고, 운영 측 확인(실제 쿼리, anon 프로브, 정책 덤프)이 별도로 필요하다.
아래 테이블·정책은 달리 표시가 없으면 전부 (A) 저장소 명세다.

## 식별자와 권한 모델 (A, 저장소 명세)

사용자 식별자는 Microsoft 계정의 oid다.
`supabase-token` 엣지 함수(`supabase/functions/supabase-token/handler.ts`)가 Microsoft 토큰을 받아 Supabase용 HS256 JWT를 발급하며, 그 JWT의 `sub`가 사용자 id가 된다.
RLS 정책은 거의 전부 `auth.jwt() ->> 'sub'`를 그 사용자 id와 비교한다.

- 소유자 스코프 RLS: 대부분의 테이블은 `user_id = auth.jwt() ->> 'sub'`(또는 `app_user`의 `microsoft_id = ... 'sub'`)로 본인 행만 접근한다.
- per-note 가시성: 노트는 "본인 소유(`user_id = sub`) 또는 `shared_users` 배열이 `sub`를 포함"하면 읽을 수 있다. 쓰기(insert/update/delete)는 소유자 본인만이다.
- service_role 우회: 백엔드(workflow-server)와 엣지 함수는 Supabase service role로 RLS를 우회한다. 각 테이블에 `service_role`용 전체 접근 정책이 명시돼 있다. MCP 경로는 service role로 조회하되 코드에서 per-note 가시성(`noteAccessFilterFor`, `src/mcp/lib/supabase.ts`)을 다시 적용해 호출자 범위로 좁힌다.

### 토큰 교환 상세 (`supabase-token`)

- 입력: `x-ms-access-token`(Graph 액세스 토큰)과 `x-ms-id-token`(검증용 ID 토큰).
- Graph `/me`로 사용자 id/email/name을 얻고, ID 토큰으로 Microsoft 신원을 검증한다.
- 테넌트 허용목록을 강제한다(`supabase/functions/_shared/msGraphAllowlist.ts`의 `enforceMsAllowlist`). 조직 판정 근거는 테넌트 ID 하나뿐이다. ID 토큰이 검증되면 그 토큰의 `tid`, ID 토큰이 없는 legacy 교환이면 Graph `/me`가 방금 받아들인 액세스 토큰의 `tid`를 쓴다. `ALLOWED_MS_TENANT_IDS`가 비면 fail-closed(500)로 거부한다.
- 이메일(Graph `mail`) 도메인은 판정에 쓰지 않는다. 외부 테넌트 관리자가 `mail`을 `x@tecace.com`처럼 바꿀 수 있기 때문이다(2026-10-15 보안 리뷰). `ALLOWED_EMAIL_DOMAINS`는 무시되고 경고 로그만 남는다. JWT의 `email` 클레임은 표시용이며 권한 판단에 쓰지 않는다.
- Graph `/me`의 id는 UUID여야 하고 토큰의 `oid`와 같아야 한다(아니면 401). Graph 응답이 8초 안에 없으면 503이다.
- 토큰의 `appid`/`azp`가 알려진 앱 등록(`MS_ID_TOKEN_CLIENT_IDS`, `MSAL_CLIENT_ID`, `MS_KNOWN_CLIENT_IDS`)이 아니면 `ms_token_client_check` 로그만 남기고 허용한다. `MS_TOKEN_REQUIRE_KNOWN_CLIENT=true`이면 403으로 막는다(confused deputy 방지).
- `SUPABASE_TOKEN_REQUIRE_ID_TOKEN=true`이면 ID 토큰 없는 legacy 교환을 거부한다(기본 꺼짐). legacy 교환은 `supabase_token_legacy_exchange` 로그로 셀 수 있다.
- 발급 JWT: `aud: authenticated`, `role: authenticated`, `iss: meeting-note`, `sub` = 검증된 `objectId`(없으면 Graph `id`). 만료는 `min(지금+1시간, ID 토큰 만료)`.
- 같은 허용목록 헬퍼를 `mcp-token`·`admin-analytics`·`admin-controls`·`generate-profile`·`identify-speakers`·`note-audio-url`의 Graph 경로도 재사용해 게이트가 어긋나지 않게 한다. workflow-server와 MCP의 Graph 토큰 경로는 `workflow-server/src/microsoftIdentity.ts`가 같은 규칙(같은 env 이름)을 적용한다.

## 테이블 (A, 저장소 명세)

### 사용자 데이터 테이블과 RLS

`20260602124000_enable_user_data_rls.sql`가 다음 테이블에 RLS를 켜고 소유자 정책을 건다.

| 테이블 | 소유자 규칙 | 비고 |
| --- | --- | --- |
| `public.app_user` | `microsoft_id = sub` | select/insert/update(본인). |
| `public.file` | `user_id = sub` | 전체 CRUD(본인). 오디오 파일 메타(`20260520120000_create_file_table.sql`). |
| `public.note` | `user_id = sub` OR `shared_users @> {sub}` | 읽기는 소유+공유, 쓰기는 소유자만. |
| `public.project` | `user_id = sub` | 전체 CRUD(본인). 프로젝트 공유는 `shared_users`(`20260630*`). |
| `public.speaker` | `user_id = sub` | 전체 CRUD(본인). |
| `public.summary_prompt` | `user_id = sub` | 전체 CRUD(본인). |

주의: `public.note`·`public.speaker`·`public.chat`·`public.session`의 CREATE TABLE은 저장소 마이그레이션에 없다.
이들은 호스팅 프로젝트에서 직접 생성됐고, 저장소에는 RLS를 켜거나 고치는 마이그레이션만 있다(컬럼 전체 명세는 저장소가 보유하지 않음).
`public.chat`/`public.session`의 RLS는 뒤늦게 추가됐다(아래 "확인된 노출" 참고).

### 개인 메모리 (`public.user_memory`)

`20260805130000_create_user_memory.sql`에 정의. 사용자당 한 행.

- 컬럼: `user_id text pk`, `memory jsonb`(구조화 메모리 전체를 담는 단일 컬럼), `processed_note_ids text[]`(노트별 중복 접힘 방지), `created_at`, `updated_at`.
- RLS: `user_memory_owner_all`(`user_id = sub`, 본인 전용) + `user_memory_service_role_all`(service role 우회).
- MCP의 `recall_personal_context`/`search_personal_context`가 읽는 바로 그 저장소다. 엄격히 본인 전용.

### 백엔드 전용 테이블

`20260602123000_enable_backend_table_rls.sql`가 `public.mcp_token`·`public.workflow_job`·`public.workflow_usage`에 RLS를 켜고 `anon`·`authenticated`의 모든 권한을 REVOKE한 뒤 `service_role`에만 전체 접근을 준다.
즉 이 테이블들은 클라이언트가 직접 못 읽고, 백엔드만 접근한다.

`public.mcp_token`(`20260527120000`)는 개인 MCP 토큰을 해시로 보관한다: `token_hash`(unique), `token_prefix`, `last_used_at`, `revoked_at`, `user_id`.
활성 토큰 조회용 부분 인덱스(`revoked_at is null`)가 있다.
토큰 만료/스코프는 `20260611120000`에서 추가됐다.

### 피드백/이슈 (`public.feedback_issues`)

공유 보드라서 읽기는 로그인 사용자 전원이다.
`20261014120000_feedback_issues_parity.sql` 부터 등록은 초기 상태(`OPEN`, 담당자 · 분류 · 해결책 없음)만, 분류 저장은 관리자만, 삭제는 작성자 본인만(`soft_delete_feedback_issue` RPC) 된다.
`20261015120000_feedback_issues_author_id.sql` 부터 본인 판정은 이메일이 아니라 `author_id`(JWT `sub`)다.
작성자 · severity · 분류 시각은 트리거가 채운다.
전체 스키마·상태·첨부 정책은 [f2-feedback](./f2-feedback)에 있다.

## 스토리지 버킷 (A, 저장소 명세)

### `meeting-recordings` (원시 오디오)

`20261009120000_scope_meeting_recordings_rls.sql`에서 소유자 스코프로 바뀌었다.

- SELECT/UPDATE/DELETE: `bucket_id = 'meeting-recordings' AND owner_id = auth.jwt() ->> 'sub'`.
- INSERT: 버킷 조건만. `owner_id`는 Supabase가 업로드 시 업로더의 `sub`로 자동 설정하므로 WITH CHECK로 단정할 수 없다. 랜덤 uuid 접두 + `upsert:false`로 타인 객체 덮어쓰기를 막는다.
- service_role 전체 접근 정책 별도 유지.
- 설계 선택: `public.file` 조인 대신 `owner_id`를 쓴다. 업로드-후-기록 흐름에서 파일 행이 아직 없는 순간이 있어 조인 정책이 업로드를 깨뜨렸기 때문. 원시 오디오는 사용자 간 공유되지 않으므로 소유권이 엄격하다(공유 분기 없음).
- 운영 확인: 이 마이그레이션 주석은 `storage.objects.owner_id`가 같은 객체의 `public.file.user_id`와 일치함을 2026-10-09 프로덕션에서 검증했다고 기록한다. 이 일치 검증만 (B) 운영 확인이며, 정책의 프로덕션 적용 여부 전체는 별도 확인 대상이다.

### 기타 버킷

- `feedback-attachments`(F2): 비공개, 서명 URL, 업로드는 `screenshots/` 또는 본인 id 접두 폴더, 삭제는 본인이 올렸고(`owner_id`) 어느 이슈에도 붙지 않은 파일만. 자세히는 [f2-feedback](./f2-feedback).
- 노트 이미지 첨부 버킷: `20260616*` 마이그레이션에 정책이 있다(소유+공유 분기 포함).

## 확인된 노출과 수정 (혼합: A 정의 + B 확인)

### chat / session 전역 읽기 노출

`20261005193000_enable_rls_chat_session.sql`.

- (B) 운영 확인: 마이그레이션 주석은 2026-10-05에 미인증 anon 키로 `public.chat` 43행, `public.session` 17행이 읽혔음을 프로브로 확인했다고 기록한다. 두 테이블이 저장소 마이그레이션이 아니라 호스팅 프로젝트에서 직접 만들어져 RLS가 꺼진 채 기본 public 권한이 남아 있던 것이 원인이다.
- (A) 저장소 명세: 이 마이그레이션이 두 테이블에 RLS를 켜고 `anon` 권한을 REVOKE한 뒤, 프로젝트 접근(소유자 또는 `project.shared_users` 협업자) 기준 정책을 건다. `session`은 프로젝트 접근 전체 CRUD, `chat`은 읽기=프로젝트 접근, insert=본인 작성 + 접근 가능 프로젝트, update/delete=작성자 본인.
- 적용 상태 자체(프로덕션에 이 마이그레이션이 실제 적용됐는지)는 저장소로 증명되지 않으며 운영 측 재프로브가 근거다.

## 정리

- 소유자 스코프 RLS + Microsoft oid(`sub`)가 사용자 데이터의 1차 경계다.
- 백엔드/엣지는 service role로 RLS를 우회하며, MCP는 코드에서 per-note 가시성을 다시 건다.
- 저장소 명세(A)는 의도를 보여주지만 프로덕션 적용(B)을 증명하지 않는다. 보안 판단에는 운영 확인을 별도로 수행한다.
- 넓은 그림은 [architecture](./architecture), 인증 엔드포인트 토큰 모델은 [mcp-connection](./mcp-connection), 공유 보드 세부는 [f2-feedback](./f2-feedback).
