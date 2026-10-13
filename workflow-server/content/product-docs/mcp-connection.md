---
title: "MCP 연결 가이드"
slug: mcp-connection
section: "Integrations"
order: 1
revision: "2026-10-13.1"
last_verified_commit: "56781a4be253a4edc98f56aaf3a53d14536ac96f"
last_verified_at: "2026-10-13"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# MCP 연결 가이드

Meeting Note MCP 서버는 어시스턴트(Claude, ChatGPT)가 사용자의 노트·요약·액션 아이템·화자·프로젝트·개인 컨텍스트를 질의하게 해준다.
서버 이름은 `meeting-note`다(`workflow-server/src/mcp/server.ts`).
비용을 줄이려고 독립 서비스를 접고 workflow-server 프로세스에 합쳤다(Render 웹 서비스 하나).
HTTP 진입점은 `workflow-server/src/mcp/transports/http.ts`가 소유하며, MCP가 아닌 경로는 호스트(workflow-server)로 흘려보낸다.

어떤 토큰 값이나 시크릿도 이 문서에 넣지 않는다.
실제 토큰은 Render 환경 그룹과 운영자에게서 받는다.

## 엔드포인트

| 경로 | 대상 클라이언트 | 전송 |
| --- | --- | --- |
| `/mcp` | Claude (claude.ai 커넥터, Claude Code) | Streamable HTTP |
| `/mcp-chatgpt` | ChatGPT (지식 소스 커넥터) | Streamable HTTP |

전송은 `StreamableHTTPServerTransport`다(`sessionIdGenerator: undefined`, 세션리스).
요청마다 서버 인스턴스를 만들고, 응답이 끝나면 닫는다.

`/health`와 `/version`은 MCP가 소유하지 않는다. 합친 프로세스에서 호스트가 서빙한다.

## 인증 모델 (Bearer 토큰)

두 엔드포인트 모두 `Authorization: Bearer <token>` 헤더를 쓴다.
해석 방식은 엔드포인트마다 다르다.

### `/mcp` (Claude)

이 엔드포인트는 두 방식 중 하나로 인증한다(`http.ts`).

1. 개인 MCP 토큰: Bearer 토큰을 `MCP_TOKEN_PEPPER`로 해시해 `mcp_token` 테이블에서 조회한다(`revoked_at is null`). 행이 있으면 그 행의 `user_id`로 스코프된다. 만료(`expires_at`)는 스키마만이 아니라 코드에서도 강제한다(과거 시각이면 거부, null이면 무기한). 사용 시 `last_used_at`을 갱신한다.
2. 정적 키: Bearer 토큰이 `MCP_API_KEY`와 상수 시간 비교로 일치하면 통과. 이 경우 사용자 스코프는 `x-meeting-note-user-id` 헤더 또는 `MEETING_NOTE_USER_ID` 환경값에서 온다.

둘 다 실패하면 401을 반환하고, `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"` 헤더를 붙인다(RFC 9728 §5.1 / MCP auth spec). 이 헤더가 없으면 만료 토큰이 커넥터를 먹통으로 만들기 때문이다.

Fail-closed: `MCP_API_KEY`가 설정돼 있지 않으면 정적 키 경로는 아무것도 허용하지 않는다(과거에 미설정 시 `/mcp`가 전면 개방됐던 버그를 닫음).

claude.ai 커넥터 실무 메모: Auth=None으로 두고 커넥터 헤더에 `Authorization: Bearer <token>`을 직접 넣는 방식이 검증돼 있다(Claude Code의 `~/.claude.json` meeting-note 서버와 같은 토큰). claude.ai의 OAuth 자동 흐름은 이 서버가 리소스 전용이라 막혀서, 정적 Bearer 헤더가 실동작 경로다.

### `/mcp-chatgpt` (ChatGPT)

`resolveChatGptUserId`(`http.ts`)가 아래 순서로 사용자를 해석한다. 먼저 맞는 것을 쓴다.

1. 개인 MCP 토큰(`mcp_token`, 위와 동일).
2. OAuth proxy 액세스 토큰: 이 서버가 authorization server 역할(DCR + Entra 위임 로그인)을 하는 모드. URL만으로 "OAuth" 연결하는 ChatGPT를 위해 `resolveUserIdFromProxyAccessToken`으로 검증.
3. `MCP_USER_TOKENS`: 토큰 -> user_id 정적 매핑(JSON). `env.ts`에서 파싱.
4. Azure JWT(oid): `MCP_OAUTH_RESOURCE` + `MCP_AZURE_TENANT_ID`가 있으면 Entra 발급 JWT를 검증해 `oid`로 Meeting Note 사용자를 해석. 이 경로는 테넌트를 검사한다.
5. Microsoft Graph `/me` fallback: Bearer 토큰으로 Graph `/me`를 불러 사용자 ID만 해석한다. 이 경로는 테넌트를 검사하지 않는다(조직 게이팅을 쓰려면 이 경로에 조직 멤버십 검사를 추가해야 함).

토큰이 제시됐지만 어떤 경로로도 사용자로 resolve되지 않으면 fail-closed로 거부한다(기본 사용자의 회의를 몰래 서빙하지 않음).
크레덴셜이 아예 없으면 `MCP_ALLOW_ANON_CHATGPT_FALLBACK`이 명시적으로 켜졌을 때만 단일 기본 사용자(`MEETING_NOTE_USER_ID`)로 떨어진다. 기본값은 꺼짐이다.
사용자 해석에 실패하면 401 + `WWW-Authenticate`(resource_metadata는 `/.well-known/oauth-protected-resource/mcp-chatgpt`).

## OAuth 디스커버리 경로

프록시/디스커버리를 위해 다음 well-known 경로를 서빙한다.

보호 리소스 메타데이터(RFC 9728):
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp-chatgpt`

메타데이터 URL은 클라이언트가 실제로 도달한 호스트를 우선 사용한다(`x-forwarded-host`/`host`로 self-heal). 과거에 디스커버리를 폐기된 독립 MCP 호스트로 핀 고정했다가 재지정 시 먹통이 된 적이 있어, 요청 호스트 기반으로 바꿨다. `MCP_PUBLIC_BASE_URL`은 forwarded host가 없을 때만 fallback.

OAuth proxy 경로(`OAUTH_PATHS`, `oauth/proxy.ts`):
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server/mcp-chatgpt`
- `/.well-known/openid-configuration`
- `/.well-known/openid-configuration/mcp-chatgpt`
- `/mcp-chatgpt/.well-known/openid-configuration`
- `/oauth/register`, `/oauth/authorize`, `/oauth/callback`, `/oauth/token`

프록시 모드에서는 이 서버가 authorization server로 광고된다(`resource`는 `<base>/mcp-chatgpt`, scope `mcp`).
프록시 모드가 아니면 Entra 테넌트 issuer를 광고한다(`https://login.microsoftonline.com/<tenantId>/v2.0`). `common` 템플릿 issuer는 RFC 8414 §3.3 검증에서 거부될 수 있어 테넌트 특정 issuer를 쓴다.

## 관련 환경 변수

실제 값은 넣지 않는다. 이름만 적는다(`workflow-server/src/mcp/lib/env.ts`).

- `MCP_API_KEY` - `/mcp` 정적 키.
- `MCP_USER_TOKENS` - ChatGPT용 토큰 -> user_id 매핑(JSON).
- `MCP_TOKEN_PEPPER` - 개인 MCP 토큰 해시 페퍼. 없으면 `SUPABASE_SERVICE_ROLE_KEY`로 떨어짐.
- `MEETING_NOTE_USER_ID` - 기본 사용자 스코프(정적 키 경로 / 허용된 익명 fallback).
- `MCP_OAUTH_RESOURCE`, `MCP_OAUTH_SCOPE`, `MCP_OAUTH_CLIENT_ID`, `MCP_OAUTH_CLIENT_SECRET`, `MCP_OAUTH_SIGNING_SECRET`, `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` - OAuth proxy 설정.
- `MCP_AZURE_TENANT_ID` - Azure JWT 테넌트 검사 + issuer.
- `MCP_ALLOW_ANON_CHATGPT_FALLBACK` - 기본 꺼짐. 켜면 크레덴셜 없는 `/mcp-chatgpt`가 기본 사용자로 떨어짐.
- `MCP_PUBLIC_BASE_URL` - forwarded host가 없을 때의 fallback base URL.

## 요청 추적과 관측

각 요청에 `requestId`(UUID)가 붙고, 시작/완료/중단/인증실패가 구조화 로그로 남는다.
MCP 세션과 툴 호출은 `mcp_session` / `mcp_tool_call`에 UUID id로 기록된다.
500대 응답은 best-effort 알림을 발송한다(디듀프 키 `mcp-http-request-failed`).

## 연결 후 쓸 수 있는 것

연결하면 `meeting-note` 서버의 툴을 쓸 수 있다.
실제 툴 목록과 선택 기준은 [guide-for-ai-agents](./guide-for-ai-agents)에 있다.
