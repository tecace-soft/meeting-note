---
title: "제품 개요"
slug: product-overview
section: "Getting started"
order: 1
revision: "2026-10-13.1"
last_verified_commit: "56781a4be253a4edc98f56aaf3a53d14536ac96f"
last_verified_at: "2026-10-13"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# Meeting Note: 제품 개요

Meeting Note는 회의를 쓸 수 있는 지식으로 바꾼다.
사용자가 오디오를 녹음하거나 업로드하면, 백엔드가 전사(AssemblyAI)하고 요약(Gemini)해서, 요약·액션 아이템·화자별 세그먼트를 담은 노트로 저장한다.
웹 앱은 Microsoft 계정(MSAL / Azure AD)으로 인증하며, MS Teams와 OneDrive에 연동된다.
모든 노트 데이터는 Supabase(Postgres)에 Row-Level Security 뒤에 저장된다.
미인증 요청은 거부되고, 인증된 요청은 자기 소유 행만 본다.

## 누구를 위한 것인가

TecAce 내부 제품이다.
사용자는 Microsoft 계정으로 로그인하고, 접근은 Azure MSAL SSO와 `supabase-token` 엣지 함수에서 강제하는 테넌트/도메인 허용목록으로 게이팅된다.

## 핵심 파이프라인

```
record / upload  ->  transcribe (AssemblyAI)  ->  diarize + speaker-ID  ->  summarize + insight (Gemini)  ->  save note (Supabase)
```

- 캡처: 브라우저나 모바일에서 녹음하거나, 오디오 파일을 업로드한다. 대용량 업로드(최대 200MB)와 장시간 녹음(약 2시간)을 지원한다.
- 전사: AssemblyAI 음성 인식을 쓴다(Gemini가 아니다).
- 화자 분리 + 화자 식별: 성문(voiceprint)이 아니라 컨텍스트 기반이다. "참석 인원" 힌트를 주면 과분할을 상한으로 억제한다.
- 요약 + 인사이트: Gemini가 요약, 액션 아이템(담당자 귀속 포함), 인덱싱에 쓰는 구조화 인사이트 레코드를 만든다.
- 영속화: 노트·요약·전사·인사이트·화자 세그먼트가 RLS 아래 Supabase에 저장된다.

## 상위 서브시스템

원시 파이프라인 위에 백엔드가 여러 서브시스템을 얹는다.

- 개인 메모리(F1'): 회의들을 가로질러 액션 아이템·협업자·프로젝트·토픽을 접는(fold) 사용자별 메모리 레이어. 평가 하네스로 게이팅하고 요약 생성에 연결한다.
- 화자 식별(F5): 컨텍스트 기반 식별. 백테스트 하네스로 같은 로스터 내 구별력(discriminability)을 올리는 방향으로 튜닝한다.
- MCP 서버: Claude·ChatGPT 같은 어시스턴트가 사용자의 노트와 개인 컨텍스트를 질의하게 해준다. 호스팅 비용을 줄이려고 백엔드 프로세스에 합쳤다.
- 비공개 회의 지식: 정책 게이팅된 지식 후보 추출과 내구성 있는 비공개 전달. 프로젝트 스코프 RLS로 보호한다.
- 피드백/이슈 트래커(F2): 버그·기능·질문용 사내 팀 보드. AI 보조 분류(triage)와 해결안(resolution) 초안을 제공한다. [f2-feedback](./f2-feedback) 참고.
- 운영 에이전트(F9): 워크플로 알림을 근본원인 초안으로 바꿔 F2 보드에 티켓으로 올린다. 사람 게이팅.

## 서피스

- 웹 앱(`src/`): React 18 + Vite + TypeScript, 주 UI. 화면: Meeting Note(녹음/전사/요약), History(검색/목록), Project, Account Settings, Issues, Admin Analytics/Controls.
- 모바일 앱(`meeting-note-mobile/`): Flutter/Dart 클라이언트로 웹과 대략 패리티를 유지한다.
- MCP: 사용자의 노트·요약·액션 아이템·화자·프로젝트·개인 컨텍스트에 대한 어시스턴트용 도구 서피스.
- 내보내기: OneDrive / MS Teams 연동으로 저장·공유.

## 아키텍처

| 레이어 | 위치 | 책임 |
| --- | --- | --- |
| 웹 프론트엔드 | `src/` | React + Vite + TypeScript UI. MSAL 인증. RLS 아래 Supabase 조회. |
| 백엔드 + MCP | `workflow-server/` | Node HTTP 백엔드. 전사/요약 파이프라인(AssemblyAI + Gemini). MCP 서버, 메모리, 인사이트 추출, 화자 식별, 지식 추출도 호스팅. Render 배포. |
| 데이터 + 엣지 | `supabase/` | Postgres 스키마 + 마이그레이션, RLS 정책, Deno 엣지 함수(토큰 교환, 서명 오디오 URL, 프로필 생성, admin). |
| 모바일 | `meeting-note-mobile/` | Flutter/Dart 앱. |

인증 흐름: 프론트엔드가 MSAL 토큰을 받아 `supabase-token` 엣지 함수로 Supabase JWT와 교환한 뒤, RLS 아래에서 데이터를 읽는다.
토큰이 없으면 RLS 때문에 빈 결과가 나오는데, 이를 절대 "데이터 없음"으로 취급하지 않는다.

## 모델

전사는 AssemblyAI다.
요약·인사이트·해결안은 Gemini를 쓰며, 모델 id는 단일 레지스트리(`workflow-server/src/gemini-models.ts`)에 핀 고정하고 오프라인 드리프트 테스트로 지킨다.
팀의 심한 비용 제약 때문에 non-lite Gemini 사용이 제한된다.

## 다음으로 볼 곳 (에이전트용)

- 에이전트 작업 가이드: [guide-for-ai-agents](./guide-for-ai-agents)
- 피드백 시스템 명세: [f2-feedback](./f2-feedback)
- MCP 연결 방법: [mcp-connection](./mcp-connection)
- 변경 이력: [release-history](./release-history)
- 더 깊은 설계 근거는 레포의 `*_DESIGN.md` 파일과 `docs/ai-native/`(레포 내부 전용, 웹 비게시)에 있다.
