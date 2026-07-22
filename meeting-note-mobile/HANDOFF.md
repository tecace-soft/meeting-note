# Meeting Note Mobile — 개발자 핸드오프

기존 웹앱(https://meetingnote.tecace.com)의 모바일 앱(iOS/Android, Flutter) 프로젝트.
디자인과 앱 뼈대는 완료 상태이며, 백엔드 연동과 출시 작업이 남은 범위입니다.

## 전달물

| 항목 | 위치 | 상태 |
|---|---|---|
| 디자인 (피그마) | https://www.figma.com/design/1fO92GOeF3MAOUMTnPJO5R | 영문 9화면 + 한글 10화면, 클릭 프로토타입 연결됨 (한글 홈에서 ▶ Present) |
| Flutter 소스 | `app/` | 실행 가능. 화면·내비·녹음 UI·Ask 채팅 완성, 데이터는 목(mock) |
| 요구사항 | `docs/01-PRD.md` | 기능 정의, 우선순위, 비목표 |
| 화면/플로우 명세 | `docs/02-screens-and-flows.md` | 상태·엣지케이스 포함 |
| 아키텍처 | `docs/03-architecture-and-components.md` | Riverpod + go_router + dio, 레이어 규칙 |
| API 계약(제안) | `docs/04-api-integration.md` | 백엔드팀과 확정 필요한 계약 초안 + 질문 6개 |
| 구현 일정 | `docs/05-implementation-plan.md` | 12주 단계별 계획 |
| **연동 체크리스트** | `docs/06-integration-checklist.md` | **여기부터 읽으세요** — TODO ↔ 엔드포인트 1:1 매핑 |

## 빠른 시작 (5분)

```bash
cd app
flutter create . --platforms=ios,android,web
flutter pub get
flutter run -d chrome        # 목 데이터로 전체 플로우 확인 가능
```

## 남은 작업 (우선순위순)

1. **백엔드 계약 확정** — `docs/04` §6의 질문 6개를 백엔드팀과 확인 (인증 방식이 최대 블로커)
2. **Microsoft 로그인** — Azure AD 모바일 앱 등록 + `/signin` 라우트 구현 (router.dart에 TODO)
3. **notes_repository.dart의 목 → 실제 API 교체** — 메서드별 엔드포인트가 주석에 명시됨
4. **ask_repository.dart 연결** — `POST /ask` (dio 호출 코드가 주석으로 준비됨)
5. **백그라운드 녹음 검증** — iOS 실기기에서 화면 잠금 1시간 테스트 (핵심 리스크)
6. **FCM 푸시** — 작업 완료 알림 (`docs/06` §6)
7. **폰트** — Poppins + Pretendard 파일을 `assets/fonts/`에 추가, pubspec 주석 해제
8. **스토어 준비** — 권한 문구·프라이버시 라벨은 README 참고

## 코드에서 지켜둔 규칙

- UI → provider → repository → dio 순서로만 호출 (UI에서 dio 직접 호출 금지)
- 모든 백엔드 연동 지점에 `// TODO(backend)` 마킹 — 전역 검색하면 작업 목록이 나옴
- 색·라운드는 `core/theme/app_theme.dart` 토큰만 사용
- 녹음은 로컬 저장 우선(디스크 기록 후 업로드) — 네트워크 실패로 오디오가 유실되면 안 됨

## 참고: 동작 프로토타입

인터랙션 스펙이 애매하면 피그마 프로토타입(화면 흐름)과 PRD를 기준으로 하되,
녹음 타이머·생성 단계·Ask 답변+출처 칩 동작은 `docs/02`의 상태 정의를 따릅니다.

문의: 2025wwgroup@gmail.com
