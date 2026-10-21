# Handoff - Meeting Note 리팩터링 (2026-10-20)

> 대체됨 (2026-10-21): 이 handoff는 [docs/refactor/REFACTOR_PLAN.md](../refactor/REFACTOR_PLAN.md)로 대체되었다.
> 규칙, gotcha, 검증 명령은 모두 그 문서로 옮겼다.

대상: 회사 SSH 서버에서 origin main(github tecace-soft/meeting-note)의 새 clone으로 작업하는 Codex.
이 문서는 이전 세션의 기억이 없고 Andrew PC의 로컬 전용 파일을 볼 수 없다는 전제로 쓰였다.

## 목표
- #14 미팅노트 리팩터링.
- 2026-10-19 아침 회의(Hansoo, Andrew)에서 진행이 결정되었다.
- 방향: 안정성 우선, 필요하면 재설계, 자동화 최대화.
- 담당은 Andrew이고 기한은 없다.
- 범위(점진 개선 vs 전면 재작성)는 아직 미정이며, 시작 전에 Andrew와 확정해야 한다.
- 참고: 이전 리노베이션 논의(2026-10-08)에서 어시스턴트 권고는 전면 재작성보다 점진적 리노베이션이었다(결정 아님).

## 상태 (검증됨)
- 브랜치 main, tip은 e26c7a2이고 origin/main과 동기화(pushed) 상태다.
- 태그는 mobile-v0.1.1, mobile-v0.1.2가 있다.
- 진행 중인 코드 작업은 없다.
- Andrew PC에만 있는 미커밋 파일은 원격 clone에 없고 리팩터링 대상도 아니다.
- 해당 파일은 C1 iOS m4a 복구 스캐폴드 5개다.
  - C1_M4A_RECOVERY_DESIGN.md
  - meeting-note-mobile/app/ios/Runner/AppDelegate.swift
  - meeting-note-mobile/app/ios/Runner/AudioMergePlugin.swift
  - meeting-note-mobile/app/lib/features/record/data/recording_service.dart
  - meeting-note-mobile/app/lib/features/record/data/audio_merge.dart
- Mac 사용자가 생길 때까지 무기한 보류 상태다.
- 리팩터링이 recording_service.dart를 건드리면 나중에 이 스캐폴드와 충돌할 수 있으니 Andrew에게 알릴 것.
- build.gradle.kts의 M 표시는 CRLF 차이뿐이고 실제 diff는 없다.

## 최근 출시 (2026-10-19~20, 모두 prod 배포/확인)
- af6635d: auth tenant-only trust (tid+oid만 신뢰, issues는 author_id 소유권, MCP admin은 oid만).
- 00fcdb6: 결정 기록 docs/decisions, advisory checker, AX-KH node assembler scripts/axkh-node.
- e597609: AX-KH 원클릭 전송 (enable_all).
- 43152df: 참석자 섹션 접기.
- abfcb57: 퇴사한 admin을 하드코딩 admin 목록에서 제거 (migration 20261020120000, prod 적용 완료).
- d72aee8, 5ad3803, a6efdf2, 358bcaa: 제품 문서 갱신, 서명, 줄바꿈 독립 본문 해시 (12개 문서 모두 live에서 fresh).
- 485d754, 1dcf665: 모바일 위젯 테스트 수정, 콜드스타트 LoadingScreen, 세션 복원 30초 타임아웃.
- 8f84af0, e26c7a2: 모바일 0.1.2 (debug key 서명 유지, 결정 DEC-0020), APK 배포 완료.

## 먼저 읽을 것
- AGENTS.md: 작업 규칙과 교훈.
- docs/decisions/: DEC-0001..0020.
  - 파일 변경 전 `npm run decisions:check`를 돌린다.
  - 활성 결정은 대체 기록 없이 어기지 않는다.
  - 규칙은 docs/decisions/README.md에 있다.
- RUNBOOK.md: 배포와 운영.
- OPS_BACKLOG.md.
- workflow-server/content/product-docs/: 코드 검증된 12개 문서 (architecture.md, data-model-and-security.md, memory.md, speaker-id.md 등).
- docs/ai-native/history.md.
- docs/reviews/:
  - 2026-09-29-ops-stability-review.md
  - 2026-10-09-renovation-review.md
  - 2026-10-09-strangler-plan.md
  - 2026-10-09-manual-deploy-steps.md
- AXKH_NODE_AND_DECISIONS_PLAN.md, docs/axkh-node/README.md.

## 아키텍처 한눈에
- web: Vite/React, Render가 main에서 자동 배포.
- workflow-server: Node/TS, MCP가 같은 프로세스에 병합됨, Render가 main에서 자동 배포.
- Supabase: Postgres/RLS/Storage/Deno edge functions.
  - edge function은 `npx supabase functions deploy <name>`으로 수동 배포한다.
  - 마이그레이션은 Andrew가 SQL Editor에서 수동 적용한다.
  - repo 마이그레이션은 자동 적용되지 않고 prod에는 drift 이력이 있으니 코드 배포 전에 컬럼을 확인할 것.
- mobile: Flutter Android, meeting-note-mobile/build_apk.sh로 수동 APK 빌드 후 sideload.
- 인증: MSAL, supabase-token edge function, 앱 JWT의 sub는 MS oid.
- 테넌트 id와 oid만 신뢰하고 이메일/도메인은 신뢰하지 않는다 (DEC-0001).

## 남은 일 (순서)
1. Andrew와 리팩터링 범위를 확정한다.
   - 점진 개선 vs 전면 재작성, 안정성 핫스팟 우선순위, 성공 기준, 웹/서버/모바일 중 대상.
   - 요구사항 명확화 규칙: 질문을 선택지로 제시하고 답을 받은 뒤 시작한다.
2. 확정 후 설계 문서를 쓰고 docs/decisions에 새 결정 기록을 추가한다.
3. 단계별로 구현하고, 각 단계에 테스트와 배포 계획을 포함한다.

별도 열린 항목 (#20):
- 2026-10-26 이후 `ms_token_client_check` 로그를 약 7일치 검토한다.
- 이후 Render에 MS_KNOWN_CLIENT_IDS를 설정하고 MS_TOKEN_REQUIRE_KNOWN_CLIENT=true로 켠다.
- /health의 msClientGate가 enforced가 되어야 한다.
- SUPABASE_TOKEN_REQUIRE_ID_TOKEN은 끈 상태로 유지한다 (msal_auth에 forceRefresh가 없음).

범위 밖 알려진 후속:
- 정적 MCP key는 x-meeting-note-user-id 헤더로 임의 사용자를 고를 수 있다.
- edge verifyAppJwt는 exp, role, iss를 확인하지 않는다.

## 지켜야 할 규칙
- 커밋과 푸시는 Andrew가 요청할 때만 한다.
- main push는 web과 backend를 자동 배포한다 (백엔드 재시작 주의, DEC-0003).
- 명시적 경로만 stage한다 (git add -A, git add ., commit -a 금지).
- --no-verify 금지.
- 공유 트리에서 stash, checkout, reset, clean, rebase 금지.
- 커밋 작성자는 andrewyoo_tecace이고 에이전트 이름, Co-Authored-By, 세션 트레일러는 넣지 않는다.
- 커밋 전에 비밀값 검사를 한다.
- 비밀값은 채팅과 파일에 쓰지 않고 env는 이름만 다룬다.
- prod DB에는 쓰지 않는다.
  - 마이그레이션은 파일만 만들고 Andrew가 SQL Editor에서 적용한다.
  - PRE/POST check와 ROLLBACK 블록을 포함한다.
  - SQL Editor는 마지막 결과만 보여 준다.
- 버그는 E2E로 재현한 뒤 수정한다.
- 품질을 우선하고 애매한 결정은 선택지 질문으로 묻는다.
- 문서는 한 문장 한 줄로 쓰고 em-dash를 쓰지 않는다.
- 제품 문서 본문을 바꾸면 revision을 올리고 `npm run docs:check`를 돌린다.
- 서명(docs:verify)은 Andrew 승인 후에 한다.
- Gemini는 lite 모델만 쓴다 (DEC-0005).
- 중첩 responseSchema는 쓰지 않는다 (DEC-0006).
- Hansoo(VP, 비즈니스)에게 보내는 메시지는 쉬운 말로 쓴다.
- C1 파일은 건드리지 않는다.

## Gotchas
- Windows CRLF와 LF 차이가 있다. 제품 문서 해시는 이제 정규화되지만(358bcaa) 생성 파일은 조심할 것.
- .githooks/pre-commit이 docs/ai-native/history.md를 재생성한다. 정상 동작이다.
- AX-KH node "Meeting Note 현황" 갱신은 수동이다 (docs/axkh-node/README.md).
  - 최근 커밋 목록 때문에 어떤 커밋 후에도 `npm run axkh:node:check`가 stale이 된다.
  - 개인 AXKH key가 필요하다 (service key는 갱신 불가).
- 인프라 소유 검증 (2026-10-20): 로그인 테넌트는 TecAce 회사 테넌트이고, 앱 등록 소유자는 Hansoo와 Andrew, Render workspace 소유자는 Hansoo다.
- 모바일 APK 서명은 기존 debug key로 유지해야 한다 (build_apk.sh의 fingerprint 검사).
- 다른 환경에서 빌드하면 서명이 바뀌어 재설치가 강제된다 (수용된 결과).

## 검증 명령
- Root: `npx vitest run`, `npm run lint`, `npm run build`, `npm run decisions:test`, `npm run decisions:check`, `npm run axkh:node:test`.
- workflow-server: `npm test`, `npx tsc --noEmit`, `npm run docs:check`.
- Mobile: `flutter test`, `flutter analyze` (기존 info 34건).
- Live: GET https://meeting-note-backend-njfb.onrender.com/health, /version, https://meetingnote.tecace.com/version.json.

## References
- 이 파일: docs/handoffs/2026-10-20-refactor-handoff.md.
- AXKH_NODE_AND_DECISIONS_PLAN.md.
- docs/decisions/README.md.
- AX-KH node "Meeting Note 현황": https://ax-consulting-business.vercel.app/admin/nodes/93e56abe-3f49-47c7-912d-d5619318ef60
