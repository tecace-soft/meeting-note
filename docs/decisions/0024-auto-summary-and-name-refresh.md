---
id: DEC-0024
date: 2026-10-28
status: active
question: 녹음 뒤 요약 시작, 화자 이름 제안, 이름을 정한 뒤의 요약 갱신을 사용자 클릭 없이 할 것인가, 그리고 사람이 고친 요약은 어떻게 보호할 것인가(U1, U9)
options:
  - (a) 현행 유지(녹음 사용과 요약 클릭, Suggest 클릭, 수동 Regenerate)
  - (b) 자동 시작과 자동 제안만 하고 요약 갱신은 수동 버튼으로만
  - (c) 자동 시작(짧은 녹음 제외, 서버 접수 전 유예와 취소), 자동 제안(적용은 사용자 확인), 주요 화자가 모두 이름을 가지면 debounce 뒤 자동 요약 갱신, 사람이 고친 요약은 덮어쓰지 않고 바꿀지 묻기
chosen: "(c). 웹: 녹음을 멈추면 5초 유예 뒤 업로드와 요약을 자동으로 시작하고(5초 미만 녹음, 중단 녹음 복구본, 녹음 중 이동으로 인한 중지는 자동 시작하지 않음; 참조 노트가 있는 최근 녹음도 자동 제출하지 않음), 프롬프트와 추가 지시와 첨부는 접힌 옵션으로 옮긴다. 최초 POST 전에 사용자와 원본에 묶인 noteId를 저장한다(S11 최소 조각). 노트가 생기면 화자 이름 제안을 노트와 전사 revision당 한 번 자동 계산해 보여 주되 적용은 사용자가 누르고, 이름은 적용 전후 언제든 바꿀 수 있으며 잠그지 않는다. 다중 화자 자동 적용은 하지 않고 인입 시 단일 화자만 소유자로 명명한다. 제안된 이름은 사용자가 확인하기 전에는 요약에 들어가지 않는다. 주요 화자(발화 시간 10% 이상, 상수 하나)가 모두 실제 이름을 가지면 마지막 이름 변경 몇 초 뒤 regenerate-summary로 한 번 갱신하고(lite 모델만, 노트당 진행 중 1개, 세션 자동 3회 상한), 이후 이름 변경은 다시 갱신한다; 10% 미만 화자는 갱신을 막지 않고 프롬프트에서 다른 참석자로 다룬다. 이름 반영 요약 업데이트 버튼은 항상 보인다. 요약이 사람 손으로 고쳐졌으면(이 화면이 생성한 텍스트와 다르거나 편집 중이거나 서버 summary_edit가 생성 텍스트가 아니면) 자동으로 덮어쓰지 않고 바꿀지 묻는다; 자동 갱신은 regenerate-summary를 persist false로 불러 서버가 저장하지 않게 하고 클라이언트가 소유자 범위로 저장한다. 실패하면 이전 요약을 유지하고 다시 시도를 보인다. 이름의 기준 출처는 계속 note.diarization이다."
reason: Hansoo가 원하는 단순한 새 Meeting Note(10/30)와 계획 5절의 승인(U1, U9)에 맞춘다. 제안 정확도가 백테스트 약 63%라 자동 적용은 하지 않고, 이름을 잠그지 않는 Andrew 요구(2026-10-21)를 지킨다. regenerate가 summary_edit에 쓰므로 열 추가 없이 생성 텍스트 비교로 사람의 수정을 판별한다. 2026-10-28 Andrew 결정 5건.
paths:
  - src/pages/TranscriptionSummary.tsx
  - src/pages/transcriptionSummary/**
  - src/lib/speakers/mainSpeakers.ts
  - src/lib/speakers/suggestionStore.ts
  - src/lib/regenerateSummary.ts
  - src/lib/summarySubmitRecord.ts
  - src/components/TranscriptDiarizedEditor.tsx
  - src/components/FloatingRecorderWidget.tsx
  - src/lib/identifySpeakers.ts
  - workflow-server/src/routes/regenerateSummary.ts
  - workflow-server/src/prompts.ts
  - workflow-server/src/pipeline/finalize.ts
  - meeting-note-mobile/app/lib/app/router.dart
  - meeting-note-mobile/app/lib/features/record/ui/record_screen.dart
  - meeting-note-mobile/app/lib/features/notes/ui/new_note_screen.dart
  - meeting-note-mobile/app/lib/features/notes/ui/processing_screen.dart
  - meeting-note-mobile/app/lib/features/notes/data/summary_submit_store.dart
  - meeting-note-mobile/app/lib/features/notes/data/notes_repository.dart
supersedes:
  - DEC-0010
source: 2026-10-28 Andrew 결정 1~5, docs/refactor/U1_U9_AUTO_SUMMARY_DESIGN.md, docs/refactor/REFACTOR_PLAN.md 5절 U1, U5, U9, U1/U2 진입 경로 표, U9 완료 기준, 4.2 S11
---
## 맥락

DEC-0010의 "임계값 이상 자동 적용"은 2026-08-25 측정 뒤 코드에서 이미 단일 화자 인입 명명만 남았다; 이 결정이 그 정책과 "이름은 잠그지 않는다"를 함께 대체한다.
U9-0(화자 지정과 공유 분리)은 별도 단계이며 이 결정에 들어 있지 않다; 제안 적용 경로는 지금도 공유하지 않는다.
서버의 전역 동시 실행 상한(S13 두 번째 부분)은 T1-9b 뒤 작업이며, 그 전까지는 클라이언트 상한으로 비용을 묶는다.
모바일(U2와 모바일 U9)은 별도 PR에서 같은 규칙을 따른다.

Andrew의 2026-10-29 후속 요청으로 모바일 U2에 같은 길이 경계, 유예와 취소, S11 제출 기록을 적용한다.
모바일 세부 설계는 docs/refactor/MOBILE_U2_U9_0_DESIGN.md에 기록한다.
