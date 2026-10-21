# Meeting Note 리팩터링 계획 2차 검토 (2026-10-21)

검토 기준은 `main`의 `cab4b3ea5746577e92ec3eb2343005e48b46b07b`다.
GitHub 원격 main과 기준 SHA가 일치하는 것을 확인하고 별도 브랜치에서 검토했다.
[계획 개정 2](../refactor/REFACTOR_PLAN.md) 848줄 전체와 [1차 검토](2026-10-21-codex-refactor-plan-review.md), 1차 반영표, 웹과 모바일의 입력 및 확인 경로, 관련 서버 코드, 운영 스크립트와 CI를 대조했다.
아래 줄 번호는 별도 표시가 없으면 `cab4b3e` 기준이다.
계획서가 기록한 예전 줄 번호와 이번 검토 기준은 구분한다.
이 문서는 검토 의견이며 계획 정본이나 기존 결정을 바꾸지 않는다.

단계적 백엔드 교체와 화면 재설계: **동의**.
안정성 첫 묶음 뒤 단순화 병행: **동의**.
무료 백엔드 유지: **동의**.
녹음 종료 후 요약, AX-KH 한 번 클릭과 자동 전송 금지, 설정 정리: **동의**.
화자 제안 자동 표시와 적용 전후의 자유로운 수정: **동의**.
U10은 선행 검증 전 제거하지 않음: **동의**.
이미 정해진 선택을 다시 묻거나 유료 전환을 권하지 않는다.

## 지적 목록

### 1. [높음] 화자 지정이 노트 공유까지 수행하는 기존 경로가 목록에서 빠졌다

위치: 계획 §5 U9/U17, §9 개인정보 원칙; `src/components/TranscriptDiarizedEditor.tsx:671`, `:755`, `:852`; `meeting-note-mobile/app/lib/features/notes/ui/summary_screen.dart:2223`; `meeting-note-mobile/app/lib/features/notes/data/notes_repository.dart:1309`.

웹에서 저장된 화자나 Microsoft 연락처를 지정하면 `shareCurrentNoteWithMicrosoftUser`가 `note.shared_users`를 갱신한다.
모바일도 화자 변경 중 `shareNoteWithMicrosoftUser`를 호출한다.
화자 이름을 고치는 행위가 열람 권한 부여와 결합되어 있으므로, U9의 편집 경로를 확대하면서 기존 부수 효과를 그대로 복제하면 개인정보 원칙과 충돌한다.
제안 수락 경로와 수동 연락처 지정 경로의 효과도 현재 서로 다르다.

수정 제안: U9/U17에 “화자 이름 적용과 공유 권한 변경을 분리한다”를 추가한다.
화자 적용과 재편집만으로 `shared_users`, 프로젝트 공유, AX-KH 참석 권한이 바뀌지 않는 것을 웹과 모바일에서 테스트한다.
공유는 U17의 명시적 사용자 동작으로 남기고, 기존 부수 효과 제거는 별도 동작 변경으로 기록한다.

### 2. [높음] S10의 자동 재개는 부분 unique index만으로 중복 실행을 막을 수 없다

위치: 계획 §3 Q3/Q4, §4.2 S10, §4.3 (b); `workflow-server/src/index.ts:1876`, `:2294`, `:2476`, `:3852`; `supabase/migrations/20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql:53`.

부분 unique index는 같은 노트에 새 활성 job 행이 두 개 생기는 것을 막는다.
서로 겹쳐 실행되는 구 인스턴스와 새 인스턴스가 동일한 기존 job 행을 실행하는 것은 막지 못한다.
현재 상태 갱신은 job id 조건뿐이며 실행 소유자나 세대 조건이 없다.
부팅 시 모든 미완료 job을 재개하면 기존 heartbeat와 orphan sweep의 보호 의미가 달라진다.

수정 제안: S10에 원자적 작업 인수, 만료되는 소유권, 실행 세대 또는 동등한 조건부 갱신을 설계 항목으로 추가한다.
실행권을 잃은 인스턴스는 완료 상태와 note 및 후처리를 더 쓰지 못하게 하고, 두 인스턴스 중첩과 DB 지연 시나리오를 검증한다.
AssemblyAI 제출 성공 뒤 전사 id 저장 전에 죽는 구간도 별도로 다뤄야 한다.
checkpoint는 전사 완료 뒤에만 남으므로 §3 Q4와 §4.5의 “재과금 없음”은 현재 모든 중단 구간에 성립하지 않는다.
“저장된 checkpoint 또는 전사 id를 재사용하는 구간에서는 재전사를 방지하며, 제출 결과를 잃는 구간은 별도 탐지와 정책이 필요”로 보장 범위를 고친다.

### 3. [높음] S12의 즉시 중단 기록은 실행 중 쓰기와 완료 후처리를 구분해야 한다

위치: 계획 §4.2 S4/S12, §4.5; `workflow-server/src/index.ts:2480`, `:2487`, `:2506`, `:2535`, `:3939`.

진행 중인 Promise와 외부 요청을 멈추기 전에 job을 실패 또는 중단 상태로 바꾸면, 사용자의 재시도와 기존 실행이 겹칠 수 있다.
`completed`가 된 뒤에도 후처리와 heartbeat가 계속되므로 메모리에 남은 실행을 모두 중단 처리하면 성공한 job을 다시 실패로 돌릴 위험도 있다.
강제 종료나 자원 부족에서는 SIGTERM 정리 코드가 끝난다는 보장도 없다.

수정 제안: 접수 차단, readiness 전환, sweep 및 worker 스케줄 중지, heartbeat와 외부 호출 중지 또는 제한된 대기, 실행권을 확인한 비종료 상태 갱신, 기한 내 종료 순서를 명시한다.
완료된 job은 완료 상태를 유지하고 후처리 미완료를 별도로 기록한다.
knowledge delivery와 extraction worker의 중지 및 lease 만료도 포함한다.
SIGTERM과 SIGKILL을 각각 시험하고, 최종 안전망은 S10의 영속 상태와 인수 규칙으로 둔다.
배포 중 인스턴스 중첩과 종료 신호 순서는 [Render 배포 문서](https://render.com/docs/deploys#graceful-shutdown)를 기준으로 확인하되 실제 서비스 설정은 S2에서 검증한다.

### 4. [높음] S11에는 응답 유실과 앱 재실행을 견디는 제출 기록이 필요하다

위치: 계획 §4.2 S11, §4.5 롤백; `src/pages/TranscriptionSummary.tsx:364`, `:418`, `:1257`, `:1271`, `:1348`; `meeting-note-mobile/app/lib/features/notes/data/notes_repository.dart:294`, `:323`, `:388`; `meeting-note-mobile/app/lib/features/notes/ui/processing_screen.dart:241`.

웹의 제출 noteId 재사용 슬롯은 메모리에 있고 jobId는 POST 성공 뒤에 저장한다.
모바일도 활성 job 영속 기록은 jobId 응답 뒤에 만들어진다.
서버가 접수했지만 응답을 받기 전에 앱을 닫으면, 다시 제출할 때 기존 요청을 찾을 정보가 부족할 수 있다.
웹은 통신 오류로 폴링을 포기하면 활성 기록을 지우며 모바일은 오래된 활성 기록을 24시간 뒤 정리한다.
이는 월말 정지처럼 오래 기다려야 하는 상황까지 포함한 복구 계약으로 충분하지 않다.

수정 제안: 최초 POST 전에 사용자와 원본에 묶인 noteId/fileId 및 제출 상태를 영속 저장하고, 재실행 시 기존 job 또는 note를 먼저 조회한다.
통신 실패와 서버의 확정 실패를 구분하고, 확정 종료 전에는 복구 정보를 임의로 버리지 않는다.
재시도 횟수와 전체 deadline, jitter, 취소, 인증 실패와 4xx 제외, 429 처리, background 복귀, 동시 poll 금지를 공통 계약에 넣는다.
오래된 서명 URL은 원본 파일의 소유권을 다시 확인해 갱신하고 로컬 녹음과 첨부를 보존한다.
월 상한 정지는 짧은 cold start와 구분해 무한 재시도하지 않는다.

### 5. [높음] 배포 사전 점검이 merge 뒤에 있으며 최근 갱신만 보는 SQL도 충분하지 않다

위치: 계획 §4.2 S1, §4.5:323, :330~336, §6 A9/A10, §9:693.

§4.5의 전달 순서는 사람 merge 뒤에 사전 점검을 둔다.
main 변경이 Render 자동 배포를 시작하면 점검이 늦다.
§9의 “사전 점검 후”와도 맞지 않는다.
최근 2분 동안 갱신된 행만 세면 heartbeat 쓰기가 실패했거나 지연된 processing/queued job은 점검에서 빠진다.
후처리가 걸린 완료 job 확인은 필요하지만 활성 상태 확인을 대체하지는 않는다.

수정 제안: Q5의 CI 및 배포 게이트 확인, 새 제출 중지, 사전 점검, merge 또는 명시적 배포 허용, 배포 후 점검 순서로 고친다.
점검은 모든 queued/processing 행과 최근 completed 후처리를 함께 확인하고, 오래된 활성 행은 원인 확인 또는 안전한 수렴 전까지 통과시키지 않는다.
조회 실패는 0건으로 취급하지 않는다.
A9도 이 판정 규칙을 사용하고, A10은 expected backend SHA를 사용해야 한다.
build filter 때문에 백엔드가 재배포되지 않는 프런트 또는 문서 전용 merge는 backend SHA 대기를 생략하고, 재배포하는 경우에도 제한 시간 내에서만 확인한다.

### 6. [중간] 무료 요금제 대응은 시간 예산 외의 제한과 잠든 worker의 진행 조건을 포함해야 한다

위치: 계획 §4.1 D2/D3/D7, §4.2 S9~S11, §6 A14; `workflow-server/src/knowledge/delivery.ts:216`, `workflow-server/src/knowledge/extraction-worker.ts:116`; `meeting-note-mobile/app/lib/features/notes/data/notes_repository.dart:383`.

무료 시간 한도는 공유 workspace 전체의 사용량으로 확인해야 하며, 한 서비스의 744시간 계산은 실제 사용량이나 충분한 여유의 증거가 아니다.
공식 문서에는 시간 외에 outbound bandwidth, build minutes, 서비스가 시작하는 외부 트래픽 제한, 임의 재시작, 휘발성 파일시스템 제한도 있다.
기존 knowledge worker는 프로세스 안에서 SQL 큐를 주기적으로 확인하므로 서버가 잠들면 큐는 보존되어도 처리 지연은 계속될 수 있다.
내부 타이머나 외부 API 호출이 서비스를 깨우는 입력 요청을 대신한다고 가정해서는 안 된다.

수정 제안: S9에 workspace 전체 사용량과 남은 기간 예측, bandwidth/build 예산, 외부 트래픽 점검, 임계 알림 담당을 추가한다.
주기 keep-alive 없이 “새 사용자 요청 또는 승인된 실제 작업 이벤트에서 재개”하는 조건과 허용 지연을 정한다.
S9의 “폴링 금지”는 유휴 keep-alive 금지와 실제 진행 중 job/worker 폴링을 구분해 적는다.
상한 정지 동안에는 제출 보존과 복귀 안내를 제공하고, 자동 복구 가능 시간은 한도 해제 이후로 제한한다.
근거: [Render 무료 서비스 제한](https://render.com/docs/free#free-web-services).
이 검토에서는 실제 workspace 사용량이나 정지 원인을 확인하지 못했다.

### 7. [중간] 자동 시작과 자동 제안 확대 전에 동시 실행 수와 입력 메모리 상한을 정해야 한다

위치: 계획 §4.1 D7, §4.2 S7, §5 U1/U9; `workflow-server/src/index.ts:354`, `:946`, `:2372`, `:2462`, `:2540`.

현재 각 제출은 `processSummarizeJob`를 바로 실행하고 서로 다른 job의 전역 동시 실행 한도는 없다.
큰 요청 본문, 파일 읽기, 첨부 base64와 결과 캐시가 겹칠 수 있다.
S7의 결과 캐시 TTL만으로는 입력과 실행 중 메모리 사용량을 제한하지 못한다.
실제 OOM 발생은 확인하지 못했으므로 원인으로 단정하지 않는다.

수정 제안: S 항목에 요약과 자동 화자 제안의 전역 및 사용자별 동시 실행 상한, 대기열 한도, 최대 입력 크기, 취소된 실행 정리와 과부하 응답을 추가한다.
제한값은 격리 부하 측정으로 정하고 거부 또는 지연 시 원본을 보존한다.
U9는 note와 전사 revision별 중복 계산을 막고 화면 재방문마다 AI를 다시 호출하지 않게 한다.

### 8. [중간] U1/U2의 자동 시작에는 취소 경계와 옵션 및 첨부의 의미가 빠져 있다

위치: 계획 §5 U1~U5, §4.8; `src/pages/TranscriptionSummary.tsx:446`, `:1324`, `:1348`; `src/components/RecordingNavigationGuard.tsx:60`; `src/components/NoteImageAttachments.tsx:171`; `workflow-server/src/index.ts:2789`; `meeting-note-mobile/app/lib/features/record/ui/record_screen.dart:122`, `:195`, `:242`.

현재 AbortController는 주로 폴링을 중단하며 접수된 서버 job의 취소 API는 없다.
따라서 이미 유료 API가 실행된 뒤에도 “몇 초 안에 취소”하면 처리가 없던 일이 된다고 표현할 수 없다.
녹음 종료 직후 새 노트 화면을 건너뛰면 프롬프트, 추가 지시, 녹음 중 사진 등 입력을 어느 시점에 확정하는지도 정해야 한다.
요약 뒤 첨부 저장은 현재 저장된 노트 첨부를 추가할 뿐, 최초 요약의 AI 입력에 첨부를 넣는 것과 같지 않다.
현재 regenerate 경로도 첨부를 다시 받지 않는다.

수정 제안: 자동 시작은 유지하되 취소 유예를 제출 전 경계로 정의하거나 서버 취소 계약과 비용 한계를 별도로 설계한다.
옵션은 녹음 전과 녹음 중에도 접힌 형태로 변경할 수 있게 하고, 제출 시점의 입력을 snapshot으로 고정한다.
녹음 중 사진을 U2까지 전달하고 U5의 “요약 후 추가”가 AI 반영까지 뜻하는지 명확히 한다.
복구 녹음, 기존 파일 선택, 2시간 자동 중지, 녹음 중 페이지 이동으로 인한 종료가 각각 자동 요약을 시작하는지와 중복 제출 방지를 E2E 표에 넣는다.
이 조건은 자동 요약 승인 자체를 다시 묻는 것이 아니다.

### 9. [중간] U15의 한 번 클릭과 실행 취소는 서버의 실제 권한 및 전송 상태를 따라야 한다

위치: 계획 §5 U15/U16; `src/components/MeetingKnowledgeModal.tsx:106`, `:129`, `:167`, `:174`, `:185`, `:219`; `workflow-server/src/knowledge/enable-all.ts:53`; `workflow-server/src/knowledge/delivery.ts:113`.

기존 enable_all은 소유권, 원문 크기, revision 충돌과 부분 초기화를 처리한다.
기존 모달은 전송 대기, worker 비활성, 모델 처리 승인 대기와 접근 철회를 구분한다.
버튼을 누른 즉시 전송 완료로 표시하거나, 이미 전달된 자료도 즉시 회수되는 것처럼 실행 취소를 표현하면 실제 상태와 다르다.

수정 제안: 한 번 클릭 버튼은 기존 enable_all과 상태 조회를 재사용하고, 부분 실패나 응답 유실에서는 상태를 다시 읽는다.
소유자가 아닌 사용자, 크기 초과, revision 충돌, 전송 대기 및 처리 승인 거부를 수용 테스트에 넣는다.
취소는 서버 disable 및 source.disabled 전파 상태를 보여 주고, 이미 전달된 자료의 회수 완료를 즉시 보증하지 않는다.
참석자 확정, 공유, 접근 복원, 모델 처리 승인은 한 번 클릭 전송의 부수 효과로 실행하지 않는다.
새 노트는 별도 클릭 전까지 계속 opt-in 해제 상태를 유지한다.

### 10. [중간] U9의 재편집은 이전 프로필 누적과 늦게 도착한 결과까지 처리해야 한다

위치: 계획 §5 화자 편집 요구, U10/U11; `src/components/TranscriptDiarizedEditor.tsx:436`, `:441`, `:509`, `:768`, `:884`; `src/lib/accumulateSpeakerProfile.ts:72`, `:104`.

현재 자동 프로필 누적은 기존 프로필을 읽어 합치며 note와 이름 단위로 화면 내 중복만 억제한다.
화자를 A에서 B로 고친 뒤에도 A에게 이미 누적한 정보가 자동으로 제거되는 경로는 확인하지 못했다.
다시 A로 고치면 화면 내 중복 억제 때문에 필요한 갱신이 생략될 수도 있다.
먼저 실행한 제안이나 프로필 갱신이 늦게 끝나 새 편집을 덮는 경우도 검증 대상이다.

수정 제안: U9 완료 기준에 `speakerKey`와 전사 revision 기준의 제안 무효화, A→B→A, 전체 이름 초기화, 편집 중 늦은 응답, 공유받은 사용자의 편집 거부를 추가한다.
프로필 누적의 출처와 재계산 또는 정정 방법을 정하고, 정정이 끝나기 전 단순 재편집을 프로필까지 완전히 복구한 것으로 표시하지 않는다.
U11에서 원시 JSON을 숨기더라도 본인이 관리하는 잘못된 프로필을 교정하거나 삭제하는 경로는 남긴다.
U10의 기존 선행 검증에는 이 재편집 일관성도 포함한다.

### 11. [중간] 28개 목록에는 별도 사용자 흐름과 같은 기능의 다른 진입점이 더 있다

위치: 계획 §5 전체, 특히 U7/U9/U11/U14/U17/U18/U27.

다음은 코드에서 확인한 누락 또는 범위가 불완전한 항목이다.
아래 처리안을 행으로 추가하거나 기존 U 항목의 하위 수용 기준으로 명시한다.

| 누락 또는 불완전 항목 | 코드 위치 | 제안 처리 |
| --- | --- | --- |
| 프로젝트 공유 대상 선택과 권한 변경 | `src/components/ShareProjectModal.tsx:86`, `src/components/AppSidebar.tsx:1153` | 유지, 노트 공유와 별도 승인으로 분류하고 프로젝트에 포함된 노트의 가시성 영향을 설명한다. |
| 중단 녹음 복구와 복구본 폐기 | `src/pages/TranscriptionSummary.tsx:1931`, 모바일 `features/record/ui/record_screen.dart:122` | 유지, 복구 제안은 자동으로 하되 폐기와 외부 전송을 묶지 않고 U1/U2 연결 규칙을 정한다. |
| 최근 녹음 선택과 서버 또는 로컬 원본 삭제 | `src/pages/TranscriptionSummary.tsx:2229`, 모바일 `features/record/ui/record_screen.dart:302` | 업로드 진입점으로 통합하되 원본 삭제 확인과 참조 노트 삭제 가드를 유지한다. |
| 모바일 홈의 직접 경로 입력 | 모바일 `features/record/ui/record_screen.dart:229`, `:273` | U7의 제거 범위를 새 노트 화면뿐 아니라 이 진입점까지 확장한다. |
| 마이크 및 카메라 권한, 녹음 중 이동 확인 | `src/context/RecorderContext.tsx:653`, `src/components/RecordingNavigationGuard.tsx:45`, 모바일 `features/record/ui/record_screen.dart:169`, `:195` | 필요한 시점의 OS 권한 요청과 이동 안내는 유지하며 자동 권한 허용으로 대체하지 않는다. |
| 화자 치환 범위와 전체 초기화 | `src/components/TranscriptDiarizedEditor.tsx:1394`, `:1441`, 모바일 `features/notes/ui/summary_screen.dart:2302`, `:2381` | U9/U26에 명시적으로 유지하고 한 구간 수정이 전체 발언 변경으로 확대되지 않게 한다. |
| 원시 프로필 편집의 다른 진입점 | `src/components/TranscriptDiarizedEditor.tsx:1632`, `src/pages/SummaryHistory.tsx:3868`, 모바일 `features/settings/ui/settings_screen.dart:439` | U11을 설정 탭만의 작업으로 보지 말고 진입점별로 읽기, 구조화 편집, 제거 여부를 정한다. |
| MCP 키 폐기와 연결 방식별 설치 단계 | `src/pages/AccountSettings.tsx:1465`, `:1591`, 모바일 `features/settings/ui/settings_screen.dart:799` | U14에 키 폐기와 OAuth 또는 개인 키별 안내를 유지하고 자동 생성이나 자동 클립보드 복사를 하지 않는다. |
| 이슈 작성의 목적 및 영역 선택, 모바일 우선순위 및 심각도 | `src/components/issues/CreateForm.tsx:182`, `:204`, 모바일 `features/issues/ui/issues_screen.dart:404`, `:477` | 현재 자동 분류 기본값을 활용해 고급 선택을 접고 수정은 허용하며 제출과 수신자 변경은 사람에게 남긴다. |

모바일 위치는 `meeting-note-mobile/app/lib/` 아래 경로다.
이 목록을 근거로 28개가 모든 수동 동작을 포괄한다고 보기는 어렵다.
단순화 후보를 추가하는 것과 이번 배치에 모두 구현하는 것은 구분한다.

### 12. [중간] U21의 “번역은 옛 노트에만 있다”는 근거가 현재 코드와 다르다

위치: 계획 §5 U21; `workflow-server/src/index.ts:2019`, `:2027`, `:2124`; `src/pages/SummaryHistory.tsx:1434`.

`TRANSLATION_ENABLED`는 반대 언어 요약 분기를 제어하지만 `translationPromise`는 감지 언어가 있으면 별도로 전사 번역을 호출한다.
따라서 새 노트에도 전사 번역 데이터가 생길 수 있다.

수정 제안: U21을 “노트에 실제 번역 데이터가 있으면 표시”로 고친다.
새 노트와 옛 노트 모두 실제 데이터 유무로 토글을 결정하고, 번역 실행 정책 자체를 바꾸려면 별도 동작 변경으로 다룬다.

### 13. [중간] A2의 일정 참석자 후보는 현재 API에 없고 이메일로 권한을 결정해서는 안 된다

위치: 계획 §5 U16, §6 A2; `src/services/graphService.ts:3`, `:54`; `src/components/MeetingKnowledgeModal.tsx:112`; DEC-0001.

현재 일정 DTO와 Graph select에는 attendees가 없다.
Calendars.Read 권한을 이미 받는 것과 참석자 데이터를 이미 가져오는 것은 다르다.
초대 목록은 실제 참석 확인이 아니며 초대 이메일과 표시 이름은 Microsoft object id를 대신할 수 없다.

수정 제안: 선택한 회의 일정의 초대 목록 조회와 회사 디렉터리의 검증된 object id 후보 매핑을 별도 작업으로 적는다.
외부 참석자, 미확인 매핑, 중복 이름은 자동 확정하지 않고, 후보 목록 실패는 권한 추가 없이 끝낸다.
사용자가 실제 참석을 확인한 뒤에만 기존 confirm_participant를 호출하고 일정 선택만으로 공유를 바꾸지 않는다.

### 14. [중간] A15의 memory:gc dry-run은 외부 AI 호출과 비용이 발생한다

위치: 계획 §6 A15, 공통 안전장치; `workflow-server/scripts/consolidate-memory-gc.ts:51`, `:64`, `:73`; `workflow-server/src/memory.ts:1107`.

현재 dry-run은 DB 최종 쓰기를 생략하지만 각 사용자의 메모리에 대해 `consolidateMemory`를 실행한다.
순수한 읽기 통계가 아니며 외부 모델 처리, 호출 비용과 사용자 식별 조각의 보고 출력이 남는다.

수정 제안: speaker:feedback의 집계 조회와 memory:gc의 모델 실행 미리보기를 구분한다.
후자는 처리 대상, 호출 상한, 비밀값의 CI 이동, 보고 보관 및 마스킹을 승인한 뒤에만 스케줄하고 `--write`는 계속 사람에게 남긴다.
승인 전에는 모델을 호출하지 않는 개수와 크기 집계만 자동화한다.

### 15. [중간] 자동화 목록에는 SQL 검증의 재현성과 운영 복구 승인 작업이 빠져 있다

위치: 계획 §6, §4.7 T2-1, §12 PGlite, §13; `workflow-server/scripts/verify-feedback-issues-sql.mjs:17`, `:22`; `workflow-server/scripts/backfill-events.ts:106`; `workflow-server/scripts/latency-report.ts`; `workflow-server/scripts/memory-coverage.ts`; `.github/workflows/ci.yml`.

T2-1은 첫 묶음인데 필요한 note RLS harness와 재현 가능한 PGlite 준비 방법이 아직 구체화되지 않았다.
기존 feedback harness는 feedback용 fixture와 migration을 검사하므로 note 권한이나 workflow_job의 동시성 검사를 대신 실행하지 않는다.
또한 모델 처리 승인 또는 실패 backfill과 복구 보고는 U15 한 번 클릭으로 없앨 수 있는 단계가 아니다.

수정 제안: A17에 격리 SQL 검증의 고정 버전 설치, note RLS fixture, workflow_job unique index 및 경합 검사와 CI 명령을 추가한다.
A18에 latency와 실패 및 복구의 익명 집계를 추가하고, A19에 knowledge 모델 처리 승인과 실패 또는 과거 데이터 backfill의 사람 승인 경로를 남긴다.
새 CI 비밀값이나 의존성은 기존 승인 규칙을 따른다.
§6의 “무인 prod DB 쓰기 0”는 자율 운영 변경에 대한 금지로 범위를 명시한다.
사용자가 승인한 요약과 화자 적용, 기존 memory fold와 F9 티켓 같은 정상 앱 실행의 DB 쓰기까지 금지하는 문장으로 해석되면 A1/A4 및 현재 동작과 모순된다.

### 16. [중간] S5/A14의 기존 F9 throttle은 일반 경보 메일까지 보호하지 않는다

위치: 계획 §4.2 S5, §6 A14, §1.3 M1/M3; `workflow-server/src/index.ts:3583`; `workflow-server/src/alerts.ts:130`.

`raiseIncident`는 `sendWorkflowAlert`와 `fileOpsIncident`를 각각 호출한다.
F9 티켓의 중복 억제와 storm cap이 일반 경보 메일 경로까지 제한하는 것은 아니다.
sweep과 enrichment 경고를 매번 연결하면 장애 중 메일과 RCA 비용이 증가할 수 있다.
또한 M1에서 failed sweep 로그의 N만 보면 이미 완료로 복구된 중단, SIGTERM 중단, DB 오류로 sweep하지 못한 경우는 집계에서 빠진다.

수정 제안: S5에 경보 발송 전 공통 중복 억제, 집계 시간창과 비용 상한, 경보 실패의 재귀 방지를 추가한다.
M1은 배포별 중단 및 재개와 수렴 결과를 함께 세고, M3은 무음 및 사용자 취소와 인프라 실패를 기계적으로 구분할 오류 분류와 집계 단위를 먼저 정한다.

### 17. [중간] T1-0a의 선행 격리 수정과 아직 남은 검증을 구분해야 한다

위치: 계획 §4.6 T1-0a:398~419, §12:765, §14; `workflow-server/src/test-setup.ts:5`, `:16`; `workflow-server/src/test-isolation.test.ts:10`; `workflow-server/src/mcp/lib/env.ts:62`; `workflow-server/src/index.ts:64`, `:315`.

현재 MCP env loader에는 skip guard가 있으며 기존 테스트 preload도 들어갔다.
반면 index.ts는 여전히 dotenv를 직접 호출하고 process 핸들러와 전역 dispatcher 및 listen 부작용이 남아 있다.
현재 canary는 MCP import 전후 한 변수의 값 동일성을 검사할 뿐, index import가 .env를 읽지 않음을 검사하지 않는다.
preload의 전역 fetch 검사는 최초 URL의 host만 보므로 loopback 응답이 외부 URL로 redirect하는 경우까지 차단했다는 증거도 아니다.
상속된 서버 자격정보도 대부분 그대로 남는다.

수정 제안: 7f66401은 “기존 MCP 경로의 부분 선행 수정”으로 기록하고 T1-0a 완료와 구분한다.
하나의 실제 skip 스위치를 사용하고 index.ts까지 포함한 sentinel 기반의 dotenv 비접근, 합성 자격정보만 사용, redirect 이후 외부 통신 차단, dispatcher 복원, 타이머와 리스너 정리 검증을 명시한다.
미래 라우트 테스트가 index를 import하기 전에 이 검증을 먼저 통과시키고 “지금도 npm test가 .env를 읽는다”는 수정 전 설명의 시제를 정리한다.

### 18. [중간] 첫 묶음과 후속 추출 표에 남은 선행 관계를 보완해야 한다

위치: 계획 §4.4, §4.6 T1-2/T1-3/T1-9b, §4.8; `workflow-server/src/index.ts:2376`, `:2404`, `:2408`, `:3467`, `:3571`.

T1-9b의 Android job 라우트는 T1-10a의 multipart와 저장 helper도 사용하지만 선행 열에는 T1-10c와 T1-3만 적혀 있다.
T1-2의 parseIssueResolution과 issueDeepLink도 최종 소유 모듈이 구체적으로 지정되지 않아 ops가 routes를 import할 가능성이 남는다.
무료 플랜의 복구 설계와 종료 처리 검토를 T1-9b 이후로만 미루면 구조 정리의 대부분이 끝날 때까지 핵심 안정성 문제가 남는다.

수정 제안: T1-9b의 선행에 T1-10a를 넣는다.
파서는 기존 순수 issues 모듈 등 하위 모듈에, 링크와 경고 상태는 공통 단일 모듈에 배치한다고 적는다.
첫 묶음은 수정된 S1/S2/S9와 Q5/Q10의 운영 조건 확인, T1-0a, note RLS 검증 준비와 T2-1로 정의한다.
로컬 서버를 실행하는 시점 전에는 loopback 조건을 충족시킨다.
S10/S12의 상태 전이와 실패 구간 설계 및 테스트 작성은 첫 묶음부터 시작하고 실제 추출 순서와 분리한다.
단순화 병행은 유지하되 U9는 지적 1의 권한 경계, U1/U2는 지적 4와 8의 제출 및 입력 계약을 선행 조건으로 둔다.
모바일 Q6/Q7은 모바일 변경만의 조건으로 두고 웹 단순화 전체를 기다리게 하지 않는다.

### 19. [낮음] 규모 근거와 결정 기록용 요약의 남은 문구를 최신 상태와 맞춰야 한다

위치: 계획 §2.2, §7, §13; `docs/refactor/REBUILD_VS_STRANGLER_MEMO.md`의 비용 및 결정 요청 절.

`cab4b3e` 파일 기준으로 테스트 파일을 제외해 센 웹은 약 26,892줄, 백엔드는 약 14,862줄, MCP는 약 4,721줄이다.
같은 방식의 knowledge TS는 약 2,058줄이므로 §7의 약 3,800줄은 집계 대상을 확인해야 한다.
모바일 lib의 Dart는 42개 약 21,278줄, migration은 56개 약 5,096줄, 현재 index.ts는 3,996줄이다.
소규모 차이로 이미 정해진 전략을 다시 논의할 필요는 없다.
다만 테스트 포함 여부와 집계 확장자, 기준 SHA를 기록해야 숫자를 재현할 수 있다.

수정 제안: 기존 570/99는 과거 실행 기록으로 유지하고 최신 통과 수처럼 쓰지 않는다.
1차 반영표에서 계획 반영과 구현 및 운영 검증 완료를 구분한다.
한 장 요약은 승인된 방향과 무료 유지의 기록으로 끝내고, 남은 유료 전환 및 방향 결정 요청을 제거한다.
재과금 없음과 U10 무조건 제거 문장도 각각 실제 보장 범위와 검증 조건부 승인에 맞춘다.

## 1차 지적 14건의 반영 확인

이 표의 “반영”은 계획의 수정을 뜻하며 구현 완료나 테스트 통과를 뜻하지 않는다.
계획 반영 10건, 부분 반영 4건으로 판단한다.

| 1차 번호 | 판정 | 확인 위치와 남은 사항 |
| --- | --- | --- |
| 1. jobs와 pipeline 순환 | 반영 | §4.4의 store 분리와 주입, §4.6의 9a→10→9b가 반영되었다. |
| 2. route 의존과 첫 묶음 | 부분 | helper 선행 추출과 0d는 반영되었으나 ops 공유 helper의 구체적 소유 및 9b→10a 선행을 보완해야 한다(지적 18). |
| 3. 무인증 parity의 한계 | 반영 | §4.6에 인증 후 성공, 거부, 실패와 SSE 및 메서드 계약 표가 추가되었다. |
| 4. 장애와 경합 검증 | 반영 | §4.6에 다섯 시나리오와 PGlite 요구가 추가되었으며 실제 harness 준비는 지적 15에 따른다. |
| 5. 서버 바인딩 | 반영 | loopback 테스트, 개발 서버와 Render 분리가 계획에 명시되었다. |
| 6. 모든 배포의 사전 점검 | 부분 | 적용 범위는 확대되었으나 merge 순서와 SQL 조건을 고쳐야 한다(지적 5). |
| 7. 롤백과 데이터 및 작업 복구 | 부분 | SHA, 관찰, 담당, PR revert와 대시보드 후속은 반영되었으나 재과금 없음의 보장 범위와 영속 재시도 조건이 부족하다(지적 2~4). |
| 8. repository 권한과 페이지 분해 | 반영 | §4.7에 메서드별 권한, 0행, RPC 및 분해 단위와 2계정 검증 보류가 기록되었다. |
| 9. import와 dotenv 검증 | 부분 | startServer 소유와 네 가지 실행 방식은 반영되었으나 선행 격리 수정의 현재 상태와 canary 범위를 보완해야 한다(지적 17). |
| 10. DEC-0005 | 반영 | 17a0140 이후 모델 registry, override 검증과 lite-only 테스트 코드가 반영된 것을 확인했다. 운영 배포 적용은 확인하지 못했다. |
| 11. 결정과 제품 문서 추적 | 반영 | 이동 PR의 paths/depends_on 갱신과 DEC-0016 후속이 명시되었다. |
| 12. SHA와 작업 트리 구분 | 반영 | §2.1의 코드 기준, 뒤쪽 +1, 작성자 PC의 C1 상태와 신규 경로 구분이 반영되었다. 최신 집계 표의 표기는 지적 19에 따른다. |
| 13. 지표의 한계 | 반영 | 줄 수와 테스트 수를 보조 지표로 낮추고 분기, 순환, 상태 소유 조건을 추가했다. 관측 방법은 지적 16에 따른다. |
| 14. 질문 영향과 시점 | 반영 | 결정자 및 시점, 복구 수준과 운영 책임 질문이 추가되고 이미 답한 선택도 기록되었다. |

## 먼저 확정할 실행 조건

이미 정해진 방향, 무료 유지, 병행 순서, 자동 요약, 한 번 클릭 전송과 화자 재편집은 다시 질문하지 않는다.

| 시점 | 남은 실행 조건 |
| --- | --- |
| 첫 운영 배포 전 | Q5의 실제 gate와 branch 보호, Q10의 담당과 관찰 및 중단 기준, 수정된 S1 점검 순서. |
| S10/S12 구현 전 | Q3/Q4의 재시도 및 자동 인수 범위와 지적 2~4의 작업 소유권 및 중단 상태 계약. 설계 검토는 첫 묶음부터 시작한다. |
| 첫 격리 검증 전 | Q11 중 실제 필요한 SQL harness 준비 방법과 순환 검사 방법. 선택적 커버리지 도구를 전체 작업의 대기 조건으로 만들지 않는다. |
| 모바일 단순화 전 | Q6의 모바일 범위와 Q7의 화면 변경 담당 조건. C1 보호 파일은 그대로 보호한다. |
| 관련 후보 수정 전 | Q9의 항목별 수용 기준과 별도 동작 변경 PR 범위. |

## 검증 범위와 한계

- 계획서 전체와 1차 반영표를 읽고 코드 및 스크립트의 호출과 입력 경로를 정적으로 대조했다.
- 웹 및 모바일의 녹음, 업로드, 처리, 결과, 화자, 설정, 공유, 프로젝트와 이슈 흐름을 확인했다.
- Render 무료 서비스와 배포 동작은 위 공식 문서와 대조했다.
- 실제 Render 콘솔, usage, branch 보호, 운영 DB 상태와 사용자 계정 E2E는 확인하지 못했다.
- 현재 clone에는 프런트 및 백엔드 테스트 의존성이 설치되어 있지 않아 build, lint, 앱 테스트, PGlite와 Flutter 검증은 실행하지 않았다.
- 파일 작성 전 `npm run decisions:check -- --files docs/reviews/2026-10-21-codex-refactor-plan-review-2.md`는 21개 결정, 대상 1개, active 결정 경로 일치 없음으로 완료했다.
- 커밋 전 작성자 이메일은 출력하지 않고 회사 계정 작성의 기준 main 및 이전 main과 일치함을 비교했다.
- 로컬 작성자 설정은 비어 있어 확인한 회사 계정의 이름과 이메일을 이번 커밋에 명시적으로 사용한다.
- 코드 파일이나 계획 정본은 수정하지 않으며, 이 검토 문서와 저장소 훅의 자동 문서 갱신만 커밋 대상으로 한다.

## 결론

**이대로 진행해도 되는지: 승인된 방향과 병행 전략은 유지하되, 높은 심각도의 공유 부수 효과, 작업 재개 및 종료 소유권, 영속 제출 기록, 배포 전 점검을 보완한 뒤 구현을 진행하는 것을 권고한다.**
