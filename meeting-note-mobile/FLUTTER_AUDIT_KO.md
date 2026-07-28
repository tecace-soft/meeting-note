# Flutter 앱 감사 리포트 (meeting-note-mobile)

작성일: 2026-07-28.
대상 커밋: `6400d79` (main, 전임자의 오늘 푸시 반영).
범위: `app/lib` 36개 파일, ~16,500 LOC.
감사 축 4개: 신뢰성/에러 처리, 아키텍처/리팩터링, 보안/인증 정합성, 웹 기능/동작 정합성.
방식: 읽기 전용 정적 분석(코드 변경 없음).

## 제약 (중요)

UI 신규 생성/삭제/재배치는 이 리팩터링 범위에서 제외한다(디자이너와 별도 협의 필요).
아래의 아키텍처/정합성 항목은 모두 "렌더링 결과가 동일하게 유지되는 코드 구조 변경" 또는 "동작/로직" 관점으로만 기술한다.
기능 자체가 없어서 새 화면이 필요한 항목은 "디자인 필요"로 따로 표시한다.

## 종합 평가

로컬 녹음 경로는 견고하다(크래시 복구 세션, MP4 finalize 검증, 파일 우선 캡처).
Supabase/PostgREST 호출도 타임아웃과 401 갱신(single-flight)이 제대로 걸려 있다.
가장 약한 층은 workflow-server 연동과 in-flight 작업 상태 관리다: 토큰 갱신 없음, 재시도 시 중복 생성, 진행 중 작업/첨부가 재시작을 못 버팀.
보안은 웹과 동등하며 모바일 고유의 우회 경로는 없다.
아키텍처는 feature-first 골격은 좋으나 공유 데이터 계층이 없어 헤더/JSON/캐시 로직이 6곳에 복붙돼 있고, 화면이 Riverpod 대신 setState 상태머신을 돌려 provider와 어긋날 수 있다.

---

## 1. 최우선 (여러 축에서 공통 지적된 고레버리지 항목)

여러 감사 축이 동시에 지적한 항목으로, 신뢰도와 개선 효과가 가장 높다.

### T1. workflow-server 호출에 토큰 갱신/401 복구가 없음 (High)
- 근거: 신뢰성 R1, 보안 S2, 아키텍처 H2.
- 위치: `notes_repository.dart:316-336`(`jobStatus`), `:253-277`(`createNote`), `:729-742`(`regenerateSummary`); `projects_repository.dart:335-346`(`_streamProjectChat`).
- 문제: 이 호출들은 저장소에서 Microsoft access token을 직접 읽어 `Bearer`로 보내며, 인터셉터도 401 갱신도 없다. 특히 `jobStatus`는 `auth()`를 아예 호출하지 않아 갱신 기회가 없다.
- 영향: MSAL access token은 ~1시간에 만료된다. 긴 트랜스크립션 중 폴링(또는 재생성/챗)이 401을 맞으면, 서버 작업은 정상인데도 "생성 실패"로 하드 실패한다.
- 방향: workflow 호출을 공유 인터셉터로 통과시켜 401 시 Microsoft 토큰을 조용히 재취득하고 1회 재생한다.

### T2. 진행 중 작업/첨부 상태가 재시작을 못 버팀 (High)
- 근거: 신뢰성 R5·R6, 정합성 P10, 아키텍처 M8.
- 위치: `notes_repository.dart:77`(`static _pendingJobAttachments`), `:297-314`; `processing_screen.dart:209-211`(4초 폴링), `:171`.
- 문제: `createNote` 시점에 잡은 첨부 경로가 프로세스 메모리(static map)에만 있고 작업 완료 후에야 저장된다. 활성 job id도 라우트 파라미터로만 전달되고 디스크에 없다.
- 영향: 긴 작업 중 앱이 종료/백그라운드 아웃되면(흔한 경우) 첨부가 조용히 유실되고, 콜드 재진입 시 진행/에러 화면을 복구할 수 없다. 웹은 job id를 localStorage에 저장해 재개한다(`TranscriptionSummary.tsx:1310`).
- 방향: pending 첨부와 활성 job 상태를 jobId 키로 디스크/보안 저장소에 저장하고 다음 실행 시 재조정한다.

### T3. `createNote`가 멱등적이지 않아 재시도 시 중복 생성 (High)
- 근거: 신뢰성 R3.
- 위치: `notes_repository.dart:242-295`(클라이언트 `noteId`를 `:250`에서 재생성, 새 `fileId`를 `:398`에서 생성); `processing_screen.dart:122`, `:214-232`에서 재트리거.
- 문제: `POST /summarize-audio/jobs`나 업로드가 서버 커밋 후 타임아웃(수신 2분)나면, 재시도가 오디오를 다시 업로드(`x-upsert:false`, 새 uuid 경로)하고 `file` 행을 또 넣고 새 `noteId`로 두 번째 작업을 만든다.
- 영향: 일시적 타임아웃+재시도마다 중복 노트, 중복 스토리지 객체, 고아 file 행이 쌓인다.
- 방향: 시도 단위로 안정적인 멱등 키(같은 `noteId`/`fileId` 재사용)를 쓰고 백엔드에서 dedupe한다.

### T4. 0행 쓰기 가드 부재로 거부된 쓰기가 "성공"으로 보임 (High)
- 근거: 정합성 P7 (웹은 이미 수정됨).
- 위치: 모바일의 rename/summary edit/profile save/delete 경로. 웹 대응: `SummaryHistory.tsx:886`(rename), `:1781`/`TranscriptionSummary.tsx:1387`(summary edit), `:1655`(profile save), `:712`(delete).
- 문제: 웹은 `.select().maybeSingle()` 후 결과 0행이면 throw한다. 모바일은 같은 작업에 이 가드가 없다.
- 영향: 권한/RLS로 실제로는 0행이 갱신됐는데도 모바일은 성공으로 보고한다. 저장/공유/이름변경/프로필 편집이 조용히 무시된다.
- 방향: 소유자 스코프 쓰기에 0행 검출 후 에러 표면화를 추가한다(웹 패턴 이식).

### T5. 공유 Supabase 데이터 계층 부재: 헤더/Dio/JSON/캐시 로직 복붙 (High, 유지보수)
- 근거: 아키텍처 H1·H3·M2·M3·M5.
- 위치: `_supabaseHeaders`/`_supabaseJsonHeaders`/`_supabaseInsertHeaders`가 `notes_repository.dart:1229-1247`, `projects_repository.dart:584-602`, `settings_repository.dart:572-576`, `recent_recordings_repository.dart:224-228`에 중복. 각 repo가 `Dio`를 인라인으로 각자 생성. MP4 finalize 검사도 `notes_repository.dart:1424-1453`와 `recording_service.dart:418-447`에 바이트 단위로 복제.
- 문제: Supabase 인증/베이스URL/타임아웃/헤더 변경을 6곳에서 고쳐야 한다. 이미 변형이 갈라졌다(recent_recordings는 `prefer` 헤더 누락).
- 영향: 최고 유지보수 리스크. 한 곳만 고치면 나머지가 드리프트.
- 방향: `core/network`에 단일 Supabase 클라이언트/provider(공유 Dio + 헤더 빌더 + 재시도 인터셉터)를 두고 모든 repo가 의존하게 한다.

---

## 2. 신뢰성 / 에러 처리

### R2. 유일한 실제 auth 인터셉터가 데드코드이며 세션을 리다이렉트 없이 삭제 (High)
- 위치: `api_client.dart:41-67`.
- 문제: 401 분기가 `refresh_token` 키를 읽지만 이 키는 어디에도 쓰이지 않는다(`auth_token_store.dart`는 `access_token`/`supabase_access_token`만 저장). 그래서 refresh는 항상 null이고 갱신이 안 돈다. 도달 불가능한 실패 경로는 `deleteAll()` 후 `catch(_)` + 미구현 `TODO`(리다이렉트 없음).
- 영향: 이 Dio는 실제로 갱신하지 못하며, 만약 실패하면 모든 토큰을 조용히 지우고 인증 화면에 사용자를 방치한다.
- 방향: 데드 분기를 제거하거나 실제 Supabase/MSAL 갱신에 연결하고 하드 실패 시 `/signin`으로 라우팅한다. (보안 S2와 동일 항목)

### R4. 401 재시도 인터셉터가 타임아웃 없는 맨 `Dio()`로 재생 (High)
- 위치: `mobile_supabase_session.dart:103`.
- 문제: `retryOnUnauthorizedInterceptor`가 `Dio().fetch(...)`로 재생한다. `connectTimeout`/`receiveTimeout`이 없는 새 클라이언트.
- 영향: 한 번 401 후 재생되는 Supabase 요청이 무한 대기해 history/projects/settings 로드가 얼어붙을 수 있다.
- 방향: 원본 클라이언트와 같은 타임아웃을 가진 Dio로 재생한다.

### R7. 녹음 `start()`에 실패 경로가 없음 (Medium)
- 위치: `recording_service.dart:160`(`_nativeRecorder.invokeMethod('start')`), `:189`; 호출부 `record_screen.dart:123`이 try/catch 없이 await.
- 문제: 복구 세션을 `:159/:187`에서 start 이전에 저장한다. start가 던지면(mic 사용 중, PlatformException) UI에서 미포착되고, 생성되지도 않은 파일을 가리키는 유령 복구 세션이 남는다.
- 영향: start 실패 시 크래시/레드스크린 + 존재하지 않는 파일을 여는 가짜 "중단된 녹음 복구" 카드.
- 방향: start를 try/catch로 감싸고 성공 후에만 복구 세션을 저장하며 권한/하드웨어 에러를 표면화한다.

### R8. SSE 챗 파싱이 잘못된 청크 하나에 전체 중단 (Medium)
- 위치: `projects_repository.dart:424-433`(`jsonDecode(raw)` 무방비); 감싸는 `try`는 `:381`에서 `on DioException`만 잡음.
- 문제: 비-JSON `data:` 라인이 `FormatException`을 던지면 `on DioException` 핸들러가 못 잡아 스트림 전체가 중단된다.
- 영향: LLM 스트림의 토큰 하나가 깨지면 진행 중 답변 전체가 버려지고 챗 에러로 표면화된다.
- 방향: 라인별 decode를 가드하고 잘못된 이벤트는 스킵/로그한다.

### R9. 원격 오디오 다운로드에 타임아웃 없음 (Medium)
- 위치: `notes_repository.dart:1270`(`_localAudioPath`의 `Dio().download(...)`).
- 문제: 타임아웃 없는 새 `Dio()`가 요약 전 오디오 소스를 다운로드한다.
- 영향: 멈춘/거대한 원격 파일이 create-note 흐름을 무한 대기시키고 실패 표면이 없다.
- 방향: connect/receive 타임아웃(및 크기 상한)이 있는 Dio를 쓴다.

### R10. 핵심 기능이 조작된 "성공" 데이터를 반환 (Medium)
- 위치: `ask_repository.dart:48-62`(지연 후 하드코딩 답변+가짜 소스 반환), `notes_repository.dart:1037-1042`(`exportToOneDrive`가 가짜 `onedrive.live.com/...` URL 반환).
- 문제: 둘 다 스텁(`TODO`)인데 지어낸 결과를 실제처럼 제시한다.
- 영향: 사용자가 그럴듯하지만 조작된 Ask 답변과 가짜 "내보내기" 링크를 받는다(조용한 정확성 실패).
- 방향: 실제 엔드포인트가 생길 때까지 feature flag/비활성 상태로 가둔다. (정합성 P11, 아키텍처 L2와 연계)

### R11. 최근 녹음이 모든 에러를 빈 목록으로 삼킴 (Medium)
- 위치: `recent_recordings_repository.dart:92-101`(`catch(_) { return const []; }`).
- 문제: 모든 실패(네트워크/인증/파싱)가 "녹음 없음"과 구분되지 않는다.
- 영향: 인증/연결 문제가 정상 빈 상태로 보여 사용자가 녹음이 사라졌다고 오해한다.
- 방향: 예상된 "테이블 없음"만 삼키고 실제 에러는 에러 UI로 전파한다.

### R12. iOS 녹음 경과시간이 wall-clock이 아닌 tick 카운트 (Medium)
- 위치: `recording_service.dart:318-328`(`_ticker`가 fire마다 `elapsed`를 1초 증가; heartbeat가 그 값을 저장).
- 문제: 표시/저장되는 `elapsedSeconds`가 1초 주기 타이머에서 오며 iOS가 백그라운드에서 이를 스로틀한다. 실제 오디오 길이와 대조하지 않는다.
- 영향: 백그라운드/긴 iOS 녹음에서 표시·복구된 길이가 실제와 어긋난다.
- 방향: tick 누적 대신 `DateTime.now() - startedAt`(일시정지 제외)에서 경과를 유도한다.

### R13. 서명 URL 재시도 루프가 재시도 불가 에러를 12회 반복 (Low)
- 위치: `notes_repository.dart:561-582`: 모든 `DioException`을 잡아 최대 12회 재시도(4xx 인증/권한 실패 포함).
- 방향: 재시도 불가 상태코드에서 조기 중단한다.

### R14. Microsoft Graph 페이지네이션 루프가 무한 (Low)
- 위치: `notes_repository.dart:903-920`: `while (requestUrl.isNotEmpty)`가 상한 없이 `@odata.nextLink`를 따라간다.
- 방향: 안전 상한(반복/결과 수)을 둔다.

### R15. iOS amplitude 구독이 `stop()`에서만 취소 (Low)
- 위치: `recording_service.dart:206`이 `_ampSub` 설정; `start()`가 이전 것을 먼저 취소하지 않음.
- 방향: `start()` 상단에서 `_ampSub`/`_ticker`를 방어적으로 취소한다.

---

## 3. 아키텍처 / 코드 품질

UI 렌더링 결과를 바꾸지 않는 코드 구조 개선만 기술한다.

### A-H4. 대형 화면들이 setState 상태머신을 돌려 provider와 어긋남 (High)
- 위치: `history_screen.dart:20-27,39-108`(setState ~18곳, `_loadVersion` 수동 캐시 경쟁, 위젯 내 백오프 재시도); `summary_screen.dart:52-125`(`noteProvider`와 갈라지는 로컬 `_note` 복사본을 콜백으로 전달); `projects_screen.dart:174-185`(임시 mutable 9필드, `build()` 내부에서 `_retryQuietly()` 호출 `:132`); `settings_screen.dart:165-290,300-413,422-607`(각기 `_load/_refresh/_refreshFromNetwork` 재구현).
- 영향: 상태가 provider와 드리프트(오래된/틀린 UI), build 중 사이드이펙트 발생, 동일 async 로드 로직 다중 유지.
- 방향: 화면 상태를 `AsyncNotifier`/`FutureProvider`로 옮기고, 변경은 콜백으로 복사본을 올리는 대신 provider를 invalidate한다. 렌더 결과 동일.

### A-M1. 도메인 로직이 위젯 안에 있음 (Medium)
- 위치: diarization 화자 치환 `summary_screen.dart:1248-1285`; 챗 그룹핑/세션 재조정 `projects_screen.dart:222-281,364-404,1141-1181`; 노트 필터/정렬/시간 버킷팅 `history_screen.dart:1999-2031,2048-2066`; 화자 색상 해싱 `summary_screen.dart:1179-1200`; Claude 설정 조립 `settings_screen.dart:1708-1727`.
- 영향: 비즈니스 규칙이 위젯 트리 없이 테스트 불가하고 화면마다 중복.
- 방향: 모델/repository/순수 헬퍼로 옮기고 위젯은 호출만.

### A-M3/M4. JSON 파싱 헬퍼가 파일마다 재구현되고 의미가 갈라짐 (Medium)
- 위치: `_stringValue`/`_stringList`/`_stringMap`/`_intValue`/`_dateValue`(및 `_int`/`_date`/`_parseDate`/`_string`)가 `notes_repository.dart`, `projects_repository.dart`, `settings_repository.dart`, `recent_recordings_repository.dart`, `meeting_note.dart`에 각각 정의. 의미가 다름(예: `meeting_note.dart:206`의 `_string`은 trim+빈값 제거, 다른 곳 `_stringValue`는 아무 객체나 `toString()`). 동시에 일부 모델은 무방비 캐스트(`ask_repository.dart:16-34`, `recent_recordings_repository.dart:202-222`, `recording_service.dart:103-111`, `meeting_note.dart:40`)로 malformed 페이로드에 크래시.
- 영향: 같은 필드가 기능마다 다르게 파싱되고, 예상 못한 백엔드 응답에 런타임 크래시.
- 방향: 공유 타입-세이프 JSON 헬퍼 모듈을 만들고 모든 `fromJson`이 이를 통하게 한다.

### A-M6. 프롬프트 모델이 두 개로 병렬 존재 + "Default" 선택 로직 삼중 (Medium)
- 위치: `SummaryPrompt`(`meeting_note.dart:190`) vs `SettingsSummaryPrompt`(`settings_repository.dart:436`), 변환은 `new_note_screen.dart:284-296`. Default 선택이 `notes_repository.dart:338-358`, `new_note_screen.dart:298-303`, settings에 반복.
- 영향: 프롬프트 개념이 두 번 모델링돼 default 규칙이 갈라질 수 있음.
- 방향: 단일 프롬프트 모델 + 단일 default 해석 헬퍼로 통일.

### A-M7. 네트워크/설정이 `settings_screen.dart`로 새어들어옴 (Medium)
- 위치: 하드코딩 엔드포인트 `settings_screen.dart:464,1719`; 위젯에서 raw `Authorization: Bearer $token` 조립 `:1709-1721`; 미사용 import `:10`.
- 방향: URL은 `core/network` 설정으로, 헤더/설정 조립은 repository로 옮기고 위젯은 반환된 문자열만 렌더.

### A-M9. UI가 auth/session 계층에 직접 접근 (Medium)
- 위치: `history_screen.dart:7`이 `mobile_supabase_session.dart` import, `initState`에서 static `MobileSupabaseSession.cachedUserId()` 호출(`:33`). 같은 화면 다른 곳은 `repository.currentUserId()`(`:518`) 사용(현재 사용자 얻는 방법 2가지).
- 방향: 단일 provider/repository 접근자로 현재 사용자 id를 노출.

### A-L1. 백엔드 계약 우회가 스키마 경계 약함을 시사 (Low)
- 위치: `projects_repository.dart:311,565`이 오타 컬럼 `'repsonse'`를 읽고 씀; `recent_recordings_repository.dart:172-186`이 `recorded_at` 컬럼 에러 후 재시도; `settings_repository.dart:162-191`이 중복 default 프롬프트를 클라이언트에서 dedupe.
- 방향: 이 shim들을 repository에 모으고 문서화하며 서버측 수정을 추적.

### A-L2. 데드/스텁/중복 코드 (Low)
- 위치: `ask_repository.dart:48-62`(완전 mock); `notes_repository.dart:1037-1042`(가짜 URL); `record_screen.dart:941`(`_Timer`가 `_RecordingTimer`의 미사용 중복); `projects_screen.dart:1631-1678`(`_ProjectNoteRow` 미참조); `notes_repository.dart:1-2`(중복 `import 'dart:convert'`).
- 방향: 미사용 심볼 제거, 의도된 스텁은 명확히 격리.

### A-L4. 하드코딩 디자인 리터럴이 팔레트 토큰 대신 중복 (Low)
- 위치: 다크/라이트 쌍 `0xFF17345D`/`0xFFE8F2FF`, 블루 그라디언트 `[0xFF4D9FFF,0xFF2F80ED]`가 여러 화면에 반복; settings 에러-레드 `0xFFE5484D`가 `506,657,783,1082`.
- 방향: 기존 `FigmaDesign`/theme 토큰을 참조(렌더 색 동일). 주의: 이건 코드 참조만 바꾸는 것이며 시각 결과는 불변.

---

## 4. 보안 / 인증 정합성

결론: 모바일 auth는 웹과 동등하며 모바일 고유 우회나 웹보다 약한 경로가 없다. 오히려 tenant-specific MSAL authority로 약간 더 강하다.
문제 없음으로 확인된 하위영역: 소스 내 시크릿 없음(커밋된 건 공개용 publishable anon 키뿐), 토큰은 전부 `flutter_secure_storage`, 토큰 로깅 없음, 실제 401 갱신은 single-flight로 정상, tenant 게이팅은 서버(`supabase-token`)에 의존, 클라이언트가 apiKey/model을 edge로 안 보냄, MSAL 설정 정상.

### S1. workflow 작업이 클라이언트가 보낸 `userId`를 신뢰 (Medium, 서버측, 웹과 동등)
- 위치: `notes_repository.dart:266`(`/summarize-audio/jobs` 바디의 `'userId': auth.userId`); `projects_repository.dart:250-291`도 같은 부류.
- 문제: 노트/작업 소유권이 요청 바디 값에서 취해지고 요청은 Microsoft bearer로만 인증된다.
- 영향: 서버가 토큰에서 유도한 신원 대신 바디 `userId`로 소유권을 정하면, 변조 클라이언트가 작업을 타인에게 귀속시킬 수 있다.
- 방향: 서버측에서 검증된 토큰으로 `userId`를 유도하고 바디 값 무시. 모바일은 웹(`TranscriptionSummary.tsx:922,1262`)과 동일하므로 수정은 백엔드 몫.

### S2. `AuthInterceptor` 401-갱신 경로가 데드/부정확 (Low)
- 위치: `api_client.dart:41-67`. (신뢰성 R2와 동일)
- 영향: 낮음. 이 Dio는 mock `AskRepository`에서만 쓰이고 `NotesRepository`엔 주입만 되고 미사용. 다만 오해를 부르는 데드코드.
- 방향: 삭제하거나 `MobileSupabaseSession.refreshAuth()`로 라우팅.

### S3. MSAL 네이티브 로깅이 VERBOSE + logcat 활성 (Low)
- 위치: `app/assets/msal_config.json:19-23`(`"log_level":"VERBOSE"`, `"logcat_enabled":true`).
- 영향: 낮음(`pii_enabled:false`로 토큰/PII는 제외). 다만 auth 메타데이터가 logcat에 기록.
- 방향: release 빌드에서 `WARNING`으로 낮추거나 logcat 비활성.

### S4. 리다이렉트 URI에 플레이스홀더 앱 ID (Low)
- 위치: `auth_config.dart:8`(`msauth://com.example.meeting_note_mobile/...`).
- 영향: 낮음. 출시 `applicationId`가 실제로 `com.example.*`면 패키지명 충돌/스쿼팅 여지. 최종 보안은 등록된 서명 인증서 해시에 의존.
- 방향: `build.gradle`의 실제 역도메인 applicationId 확인 및 Azure 리다이렉트/서명 해시 일치 확인.

### S5. 미사용 과대 Graph 스코프 목록 (Low, 정리)
- 위치: `auth_config.dart:15-23`(`microsoftGraphScopes`: `Files.ReadWrite.All`, `Chat.ReadWrite`, `Calendars.Read` 등). 실제 `signIn`/`acquireTokenSilent`는 `microsoftLoginScopes`(`user.read`, `User.ReadBasic.All`)만 요청(`microsoft_auth_service_factory_msal.dart:42,52`).
- 영향: 현재 없음(최소 권한 유지, 좋음). 향후 누군가 넓은 목록을 acquire에 연결할 위험.
- 방향: 미사용 상수 삭제하거나 존재 이유 문서화.

---

## 5. 웹 기능/동작 정합성

모바일은 얇은 뷰어가 아니라 완전한 클라이언트다: auth, history/calendar, 트랜스크립트 화자 편집, 프로젝트 스트리밍 챗, settings/MCP에서 웹과 일치.
아래는 격차. "동작/로직 격차(UI 없이 수정 가능)"와 "기능 부재(디자인 필요)"를 분리한다.

### 5a. 동작/로직 격차 (UI 재설계 없이 수정 가능)

- **P7 (High): 0행 쓰기 가드 부재** — 위 T4 참조. 최우선.
- **P10 (Medium): in-flight 작업 재개 불가** — 위 T2 참조.
- **P13 (Low): 롱폴 실패 내성이 약함** — `processing_screen.dart:159`의 `_poll`이 첫 예외에서 에러 상태 설정(4초 타이머는 계속 돌아 자가 복구 가능하나 실패가 깜빡임). 웹은 토큰 갱신+백오프로 연속 5회까지 관용(`TranscriptionSummary.tsx:957`). 방향: 에러 표면화 전 소규모 연속실패 임계값 추가.

### 5b. 기능 부재 (구현 시 새 UI 필요 → 디자이너 협의 대상)

이 항목들은 이번 리팩터링에서 코드로 만들지 않는다. 인지/계획용으로만 기록한다.

- **P1: 수동 요약 편집 부재** — 웹은 `summary_edit`를 직접 편집/저장. 모바일 없음.
- **P2: 녹음 오디오 재생 부재** — 웹은 서명 URL로 재생. 모바일 없음.
- **P3: 프로젝트/노트 공유 부재** — 웹 `shared_users` 공유. 모바일 없음.
- **P11: OneDrive 내보내기/Teams 전달 부재** — 웹 `SaveSummary.tsx`. 모바일 `exportToOneDrive`는 스텁(가짜 URL). 사인인 화면은 OneDrive 권한을 광고하는데 기능이 없음.
- **첨부 표시 부재** — 첨부는 업로드되나 노트에서 표시되지 않음(T2와 연계).
- **P12 (Low): 번역(en/ko) 토글/편집 부재** — 모바일은 `summary_translations`를 표시 폴백으로만 읽음. 토글/편집 없음. 의도 확인 필요.
- **P5: Ask 스텁은 웹 격차 아님** — 웹엔 전역 Ask가 없으므로(프로젝트 챗만) 모바일 Ask mock은 고아 코드. R10/A-L2로 처리.

---

## 6. 제안 우선순위 (리팩터링 착수 시)

감사 결과이며 실행은 별도 승인 후. UI 신규/삭제/재배치는 제외.

1. **정확성 즉시 수정 (동작 버그)**: T4(0행 가드), T1(workflow 토큰 갱신), T3(createNote 멱등성), T2(작업/첨부 영속화). 사용자 데이터/신뢰에 직접 영향.
2. **안전한 실패 경로**: R4/R9(타임아웃 없는 Dio), R7(녹음 start), R8(SSE 파싱), R11(에러 삼킴), R2/S2(데드 인터셉터 정리).
3. **구조 기반 다지기 (렌더 불변)**: T5(공유 Supabase 데이터 계층), A-M3/M4(공유 JSON 헬퍼), A-H4(화면 상태를 AsyncNotifier로), A-M1(도메인 로직 이동).
4. **정리/일관성**: A-M6(프롬프트 모델 통일), A-M7/M9(경계 정리), A-L1/L2/L4(shim·데드코드·팔레트 토큰), 보안 저위험(S3/S4/S5).
5. **스텁 처리**: R10/P11(Ask·OneDrive 스텁을 비활성/플래그 뒤로).

기능 부재(5b)는 디자이너 협의 후 별도 트랙.
