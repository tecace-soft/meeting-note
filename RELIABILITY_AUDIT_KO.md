# 종합 결과: 데모가 자주 깨지는 이유

근본 패턴은 3가지입니다.

1. **에러가 조용히 삼켜짐**: 실패해도 `console.error`만 찍고 UI는 정상인 척 함. 사용자는 "데이터가 없네?", "버튼이 안 먹네?"만 보게 됨
2. **일시적 실패에 재시도가 전혀 없음**: 네트워크 블립 1번, Graph API 429 1번이면 전체 워크플로우가 실패 처리됨
3. **거대 파일 + 로직 3중 복제**: 4,000줄짜리 페이지에 같은 로직이 3벌 복사되어 있어 한 곳을 고쳐도 다른 곳은 여전히 깨짐

---

## Critical (데모 즉사급)

| # | 위치 | 문제 |
|---|---|---|
| C1 | `src/context/RecorderContext.tsx:836-844` | **두 번째 녹음을 시작하면 새 녹음이 죽음.** effect cleanup이 `recordedAudioUrl` 변경 시마다 실행되어 새로 만든 스트림/타이머를 정지시킴 |
| C2 | `workflow-server/src/index.ts:1826,1915` | 서버 재시작/배포/크래시 시 진행 중이던 잡이 **영원히 `processing`에 갇힘.** 클라이언트는 1시간 동안 헛폴링 |
| C3 | `TranscriptionSummary.tsx:894-901` + `index.ts:1966,559` | 2.5초마다 폴링하는데 **폴링 1회만 실패해도 전체 실패 처리.** 게다가 백엔드가 폴링마다 Graph `/me`를 호출해서 Graph 한 번 삐끗하면 잘 돌아가는 잡이 "실패"로 표시됨 |
| C4 | `src/main.tsx`, `App.tsx` | **React Error Boundary가 앱 전체에 하나도 없음.** 4,000줄 페이지에서 렌더 에러 1개 = 흰 화면 |
| C5 | `src/config/supabaseConfig.ts:37-56` | 토큰 준비가 5초 안에 안 되면 **anon 키로 조용히 진행** → RLS가 빈 결과 반환 → 에러 없이 "노트가 없습니다" 표시. "데모 중에 내 데이터가 사라졌다"의 주범 |
| C6 | `src/context/AuthContext.tsx:90-133` + `supabaseConfig.ts:62` | 토큰 교환(MSAL → Graph → edge function) 실패 시 재시도 없이 **모든 DB 쿼리가 연쇄 실패.** 또는 redirect 모드면 **페이지 전체가 리로드**되어 녹음 등 모든 상태 소실 |
| C7 | `AuthContext.tsx:108` + `supabase-token` | Supabase JWT 수명이 정확히 60분, 만료 60초 전에야 갱신. 갱신 체인(MSAL→Graph→edge fn)에 타임아웃/재시도/중복제거 없음. **1시간짜리 데모는 59분쯤 절벽을 맞음** |
| C8 | `TranscriptionSummary.tsx:891-1096` | 요약 생성 중 **새로고침하면 잡 추적이 완전히 소실**(jobId 미저장). 페이지 이탈 시 폴링 루프가 언마운트된 컴포넌트에 setState 계속 |
| C9 | `src/lib/msalRedirect.ts:12-14` | 터치 지원 노트북 + 뷰포트 ≤1024px(프로젝터/화면분할)이면 **모바일로 오인해 redirect 모드 전환** → C6과 결합해 토큰 갱신 = 페이지 리로드. 정확히 데모 환경 프로파일 |

## High (데모 중 높은 확률로 발생)

**신뢰성 (재시도/체크포인트 부재)**

- `index.ts:1150` AssemblyAI 폴링 루프에 try/catch 없음, 네트워크 에러 1번 = 잡 전체 사망
- `index.ts:1601-1783` 스테이지 간 체크포인트 없음: 요약 실패 시 이미 돈 내고 받은 트랜스크립트도 폐기, 처음부터 재실행
- `index.ts:1684` + `parsers.ts:25` 프로덕션 요약 경로는 Gemini 출력 `JSON.parse` 실패 시 복구 로직 없음 (테스트 경로에는 있음)
- `index.ts:673` Gemini 429/500/503에 재시도 0회
- `index.ts:1586` 잡 상태 쓰기 실패를 `console.warn`으로 삼킴: 완료된 잡도 `processing`으로 방치 가능
- `RecorderContext.tsx:485,597` 마지막 청크 저장이 fire-and-forget이라 **녹음 마지막 ~2초 유실 가능**

**조용한 실패 (사용자에게 거짓 성공 표시)**

- `SummaryHistory.tsx:875,1799,1765` 공유받은 노트의 제목/요약 수정이 **0행 업데이트인데 성공으로 표시**, 새로고침하면 사라짐
- `SummaryHistory.tsx:749` 노트 조회 실패 = 빈 목록 표시, 에러 UI 없음
- `SummaryHistory.tsx:1745` 오디오 재생 실패 메시지를 만들어놓고 console에만 출력
- `SummaryHistory.tsx:1608` 서명된 오디오 URL을 만료 무시하고 영구 캐시
- `TranscriptionSummary.tsx:1891` 업로드 실패 사유를 저장해놓고 화면엔 "Error"만 표시

**설정/보안**

- `msalConfig.ts:17`, `supabaseConfig.ts:13` env 변수 누락 시 placeholder로 조용히 부팅, 나중에 알 수 없는 에러. `.env.example`도 없고 README에 Supabase 변수 미문서화
- `supabase-token`: `verify_jwt=false` + 테넌트 검증 없음이라 **전 세계 아무 Microsoft 계정이나 authenticated JWT 발급 가능**
- `generate-profile`: 인증이 아예 없어 누구나 Gemini 쿼터 소진 가능 → 데모 중 요약 사망
- `Project.tsx:552` n8n 웹훅 타임아웃 없음(행 걸리면 스피너 영구), URL 하드코딩

## Medium (요약)

- `alert()`/`confirm()` 남발 (SaveSummary 6곳, TranscriptionSummary 3곳): 데모 화면에서 브라우저 모달
- 중복 제출 방지 없음: 더블클릭 = 파이프라인 2회 결제
- 검색 키스트로크마다 전체 테이블 `select('*')` (트랜스크립트 포함) + 디바운스 없음
- `Promise.all`로 스피커 프로필 생성: 1명 실패 = 전체 실패
- 여러 useEffect에 cancelled 플래그 없음 (stale 응답이 최신 데이터 덮어씀)
- `stopRecording`이 `onstop` 이벤트를 타임아웃 없이 대기: 안 오면 Stop 버튼 영구 행
- 동기식 `/summarize-audio` 엔드포인트가 30분+ HTTP 요청 유지 (프록시 타임아웃에 취약)

## 구조적 문제

- **`SummaryHistory.tsx` 4,175줄** = 데이터 레이어 + 캘린더 엔진 + 오디오 재생 엔진 + 12개 뮤테이션 핸들러 + UI(노트 상세 패널이 3벌 복사됨), useState 50개
- **동일 로직이 페이지 3곳에 verbatim 복제**: 프로필 동기화 모달, Teams 전달 모달, 재생 엔진, transcript 저장 등. 실제로 0행 업데이트 버그가 한 copy에서는 고쳐졌는데 다른 두 copy는 그대로임
- **`workflow-server/src/index.ts` 2,164줄** = 라우팅 + 멀티파트 파싱 + 3개 벤더 클라이언트 + 잡 오케스트레이션 + 영속성이 한 파일
- 공유 데이터 액세스 레이어 없음: 페이지마다 Supabase 쿼리와 낙관적 업데이트를 손으로 재작성

---

# 개선 제안 (우선순위 로드맵)

**Phase 1: 데모 생존 킷 (효과 대비 작업량 최소)**

1. Error Boundary 추가 (전역 + 라우트별)
2. C1 녹음 cleanup 버그 수정
3. 폴링 내성: 연속 N회 실패까지 허용 + jobId를 localStorage에 저장해 새로고침 후 복구
4. anon 폴백 제거: 인증 미준비 시 명시적 "인증 중" 상태 표시
5. 토큰 선제 갱신 (50분 시점, 백그라운드) + 교환 실패 시 재시도
6. 서버 부팅 시 고아 잡 정리 + 잡 상태 쓰기 재시도

**Phase 2: 에러 가시화**

- 삼켜진 catch들을 UI 에러 상태로 연결 (빈 목록 대신 에러+재시도 버튼)
- `alert()` 제거, 인라인 에러/토스트로 통일
- 0행 업데이트를 실패로 처리 (`.select().maybeSingle()` 패턴 전파)
- env 검증 fail-fast + `.env.example` 추가

**Phase 3: 구조 개선**

- 파이프라인에 스테이지 체크포인트 + 벤더 호출 재시도 래퍼
- 공유 데이터 레이어(`useNotes`/`useNoteActions`) 추출, 3중 복제 제거
- 거대 페이지 분해
- edge function 인증 구멍 봉합 (테넌트 검증, generate-profile 인증)

Phase 1만 해도 데모 체감 안정성이 크게 달라질 겁니다.
보안 이슈(supabase-token 테넌트 미검증)는 데모와 별개로 빠른 시일 내 처리를 권합니다.
