---
id: DEC-0027
date: 2026-11-07
status: active
question: 2026-11 보안 감사에서 나온 교차 사용자 쓰기와 읽기 경로를 어떤 기준으로 막을 것인가
options:
  - (a) 정상 경로를 바꾸지 않는 서버와 RLS 조건만 추가하고, 설정과 큰 기능 변경은 운영 확인 뒤로 미룬다
  - (b) 토큰 client gate, tenant fail-closed, OAuth 동의 화면, 메이저 의존성 업그레이드까지 한 번에 적용한다
chosen: (a). 요약 작업 경로는 다른 사용자가 소유한 noteId를 403으로 거부하고, 서비스 키 쓰기에 user_id 조건을 붙인다. regenerate-summary는 공유 받은 사용자에게 결과만 돌려주며 저장하지 않고, 소유자 메모리를 프롬프트에 넣지 않고, 소유자 메모리에 접지 않는다(공유는 읽기 전용이라는 note RLS와 맞춘다). note-audio-url의 owner_id 없는 객체 서명은 오디오 버킷에 한정하고, 그 객체를 가리키는 file 행이 모두 노트 소유자 것일 때만 서명한다. migration은 서비스 전용 RPC 두 개의 anon과 authenticated 실행 권한을 회수하고, note_image가 작성자 폴더 밖의 객체를 가리키지 못하게 하고, 채팅 수정이 접근할 수 없는 프로젝트로 옮기지 못하게 한다. MCP 노트 범위 필터는 형식이 잘못된 user id에서 닫힌 쪽으로 실패하고, list_projects는 위조된 note.projects 참조로 남의 프로젝트 행을 보여 주지 않는다. 의존성은 semver 범위 안의 npm audit fix만 적용한다.
reason: 각 수정은 정상 사용자가 밟는 경로(자기 노트 재시도, 소유자 재생성, 자기 폴더 업로드, 서비스 키 RPC 호출)를 그대로 두고 공격 경로만 닫는다. 토큰 client gate와 tenant gate는 운영 환경 변수 값을 확인해야 안전하게 켤 수 있고, OAuth 동의 화면과 메이저 업그레이드는 별도 설계와 회귀 검증이 필요해 분리한다.
paths:
  - workflow-server/src/routes/jobs.ts
  - workflow-server/src/routes/regenerateSummary.ts
  - workflow-server/src/pipeline/finalize.ts
  - workflow-server/src/jobs/store.ts
  - workflow-server/src/mcp/lib/supabase.ts
  - workflow-server/src/mcp/tools/projects.ts
  - supabase/functions/note-audio-url/index.ts
  - supabase/migrations/20261107120000_security_audit_hardening.sql
supersedes: []
source: 2026-11-07 Hans 요청 레포 전체 보안 감사와 "안전하게 고칠 수 있는 것은 모두 수행" 지시
---
## 남긴 항목

운영 확인이 먼저인 항목: MS_TOKEN_REQUIRE_KNOWN_CLIENT, SUPABASE_TOKEN_REQUIRE_ID_TOKEN, ALLOWED_MS_TENANT_IDS 운영 값.
별도 설계가 필요한 항목: MCP OAuth proxy 동의 화면, session 정책의 소유자 전용 수정과 삭제, ops incident 읽기 범위, zod 4와 react-router 7 같은 메이저 업그레이드.
migration은 저장소에만 추가했으며 운영 DB 적용은 배포 절차를 따른다.
