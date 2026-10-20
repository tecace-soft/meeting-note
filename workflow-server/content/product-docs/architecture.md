---
title: "시스템 아키텍처"
slug: architecture
section: "Getting started"
order: 3
summary: "프론트엔드·workflow-server(+합친 MCP)·Supabase·배포를 잇는 전체 시스템 지도. 녹음->전사->화자->요약->저장 파이프라인과 MSAL->Supabase 토큰->RLS 인증 흐름의 진입점."
depends_on:
  - "workflow-server/src/index.ts"
  - "workflow-server/src/mcp/server.ts"
  - "src/App.tsx"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 시스템 아키텍처

이 문서는 Meeting Note 전체를 한 장의 지도로 보여준다.
세부는 각 서브시스템 문서에 있고, 여기서는 구성 요소가 어떻게 맞물리는지와 어디로 가야 하는지를 정리한다.
각 레이어의 경로를 그대로 적었으니, 코드를 건드리기 전 그 경로부터 연다.

## 네 개의 레이어

| 레이어 | 위치 | 책임 |
| --- | --- | --- |
| 웹 프론트엔드 | `src/` | React 18 + Vite + TypeScript UI. MSAL 인증. Supabase를 RLS 아래에서 직접 조회하고, 무거운 작업은 workflow-server를 호출. |
| 백엔드 + MCP | `workflow-server/src/` | Node HTTP 서버. 전사/요약 파이프라인, 메모리, 인사이트, 화자 식별, 지식 추출. 같은 프로세스가 MCP 서버(`src/mcp/`)도 호스팅. |
| 데이터 + 엣지 | `supabase/` | Postgres 스키마 + 마이그레이션, RLS 정책, Deno 엣지 함수(`supabase/functions/`). |
| 모바일 | `meeting-note-mobile/` | Flutter/Dart 앱. 웹과 대략 패리티. |

## 웹 프론트엔드 (`src/`)

Vite + React + TypeScript SPA다.
진입점은 `src/App.tsx`이며, `@azure/msal-browser`의 `PublicClientApplication`을 초기화하고 `MsalProvider`로 앱을 감싼다.
라우팅은 `react-router-dom`이고, 로그인(`/`)을 제외한 모든 화면은 `AppShell` 아래에 들어간다.
현재 라우트는 `/transcription-summary`, `/history`, `/project`, `/account-settings`, `/issues`, `/docs`, `/admin-analytics`, `/admin-controls`, `/transcription-model-test`다.
프론트엔드는 Supabase를 RLS 아래에서 직접 읽고(노트·프로젝트·이슈 등), 전사·요약·해결안 같은 무거운 작업만 workflow-server로 보낸다.

## 백엔드 + MCP (`workflow-server/src/`)

Node로 작성한 단일 HTTP 서버다.
진입점은 `workflow-server/src/index.ts`이고, 프레임워크 없이 `req.method`와 `url.pathname`으로 직접 라우팅한다.

호스트(workflow-server)가 소유하는 주요 경로:

- `GET /` · `GET /health` · `GET /version` - 헬스/버전.
- `POST /summarize-audio` + `POST /summarize-audio/jobs` - 오디오 전사+요약(동기/잡).
- `POST /android/recordings/jobs` - 모바일 녹음 잡.
- `POST /regenerate-summary` · `POST /refresh-note-insight` - 요약 재생성 / 인사이트 재추출.
- `POST /issue-resolution` · `POST /issue-notify` - F2 해결안/알림([f2-feedback](./f2-feedback)).
- `POST /project-chat` + `POST /project-chat/stream` - 프로젝트 챗.
- `GET /meeting-briefing` · `GET /product-docs` - 브리핑, 본 문서 세트.
- `POST /admin/backfill-insight` · `POST /transcription-test` - 운영/테스트.

### 합친 MCP 서버 (`workflow-server/src/mcp/`)

MCP 서버는 과거 독립 Render 서비스였으나 호스팅 비용을 줄이려고 이 프로세스에 합쳐졌다.
`index.ts`가 요청을 먼저 `handleMcpRequest`(`src/mcp/transports/http.ts`)로 넘기고, MCP 경로(`/mcp`, `/mcp-chatgpt`, `/.well-known/oauth-protected-resource*`, `/admin/*`)가 아니면 호스트 라우팅으로 흘려보낸다.
MCP 서버 자체는 `src/mcp/server.ts`의 `createMeetingNoteMcpServer`가 만들며, 이름은 `meeting-note`다.
이 서버는 노트·화자·프로젝트·컨텍스트·메모리·평가·지식·제품문서 툴 그룹과 노트/화자 리소스를 등록한다.
연결 방법과 토큰 모델은 [mcp-connection](./mcp-connection), 실제 툴 목록은 [guide-for-ai-agents](./guide-for-ai-agents)에 있다.

## 데이터 + 엣지 (`supabase/`)

데이터는 Supabase(Postgres)에 있고, 스키마·RLS는 `supabase/migrations/*.sql`로 관리한다.
Deno 엣지 함수는 `supabase/functions/`에 있다: `supabase-token`(토큰 교환), `note-audio-url`(서명 오디오 URL), `identify-speakers`·`generate-profile`(화자 식별/프로필), `admin-analytics`·`admin-controls`(관리), `mcp-token`(개인 MCP 토큰).
스키마·RLS의 저장소 명세와 운영 적용 상태의 구분, 그리고 권한 모델은 [data-model-and-security](./data-model-and-security)에 있다.

## 핵심 파이프라인

```
record / upload  ->  transcribe (AssemblyAI)  ->  diarize + speaker-ID  ->  summarize + insight (Gemini)  ->  save note (Supabase)
```

- 캡처: 브라우저·모바일 녹음 또는 오디오 업로드.
- 전사: AssemblyAI로 전사한다(`index.ts`의 `transcribeWithAssembly`). Gemini가 아니다.
- 화자 분리 + 식별: 성문이 아니라 컨텍스트 기반이다. `identify-speakers` / `generate-profile` 엣지 함수가 관여한다.
- 요약 + 인사이트: Gemini가 요약·액션 아이템·구조화 인사이트(`note_insight`)를 만든다.
- 저장: 노트·요약·전사·인사이트·화자 세그먼트를 RLS 아래 Supabase에 저장한다.

## 인증 흐름 (MSAL -> Supabase 토큰 -> RLS)

1. 프론트엔드가 MSAL(Azure AD)로 Microsoft 로그인을 하고 액세스/ID 토큰을 얻는다.
2. `supabase-token` 엣지 함수가 그 토큰을 받아(테넌트 허용목록 통과 시. 이메일 도메인은 판정에 쓰지 않음) Supabase용 HS256 JWT를 발급한다. JWT의 `sub`는 Microsoft 사용자 식별자(oid)다.
3. 프론트엔드는 이 JWT로 Supabase를 조회하고, RLS가 각 행을 소유자/공유 범위로 건다. 이슈 보드의 작성자 판정은 이메일이 아니라 `author_id`(JWT `sub`)다.

백엔드(workflow-server)도 같은 규칙을 쓴다. Microsoft 토큰은 Graph `/me`로 검증하고, 그 토큰의 테넌트 ID가 허용목록에 있어야 하며(`microsoftIdentity.ts`의 `resolveMicrosoftCaller`), 사용자 식별은 oid(UUID)로만 한다. 이메일은 표시용이다. 토큰의 앱 등록 확인은 기본 로그만 남기고, 켜면 막는다(`MS_TOKEN_REQUIRE_KNOWN_CLIENT`). `/health`는 두 게이트의 모드(`msTenantGate`, `msClientGate`)를 보여 준다. 모바일 앱도 ID 토큰(`x-ms-id-token`)을 함께 보낸다.
MCP 관리자 판정도 oid 목록(`MCP_ADMIN_MICROSOFT_IDS`)만 쓰며, 이메일 경로는 없다.

토큰이 없으면 RLS 때문에 빈 결과가 나온다.
이를 절대 "데이터 없음"으로 해석하지 않는다.
MCP 경로는 DB RLS에 더해 코드에서도 per-note 가시성(본인 소유 또는 `shared_users` 포함)을 다시 적용한다(`src/mcp/lib/supabase.ts`의 `noteAccessFilterFor`).

## 배포

- 백엔드(workflow-server, 합친 MCP 포함)와 프론트엔드는 Render에서 `main` 브랜치 기준으로 배포된다. 런타임 커밋은 `RENDER_GIT_COMMIT`로 노출된다(`/version`, `productDocs.ts`가 freshness 스탬프에 사용).
- Supabase 마이그레이션은 자동 적용이 아니다. 손으로 적용한다. 그래서 저장소 스키마가 프로덕션 DB 상태를 보장하지 않는다. 자세한 구분은 [data-model-and-security](./data-model-and-security) 참고.
- 모바일은 자동 배포가 없다. 수동 APK 빌드다.
- 배포 IaC 파일은 저장소에 없다(Render 설정은 대시보드/환경 그룹에 있음). 이 단락의 배포 세부(브랜치, 자동/수동)는 운영 설정이므로 운영자 확인이 별도로 필요하다.

## 다음으로 볼 곳

- 데이터 모델과 보안: [data-model-and-security](./data-model-and-security)
- MCP 연결: [mcp-connection](./mcp-connection)
- 에이전트 작업 가이드와 MCP 툴: [guide-for-ai-agents](./guide-for-ai-agents)
- 제품 개요: [product-overview](./product-overview)
