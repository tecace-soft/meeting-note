---
id: DEC-0010
date: 2026-08-12
status: superseded
question: 화자 이름 제안을 어떻게 적용하고, 이름의 기준 출처를 무엇으로 둘 것인가
options:
  - 모든 제안을 자동 적용
  - 모든 제안을 사용자 확인 후 적용
  - 신뢰도 임계값 이상은 자동 적용, 미만은 대기 제안으로 두고 한 번 탭으로 확인
chosen: 하이브리드 적용(임계값은 F8로 조정)이며, note.diarization을 이름의 기준 출처로 삼고 note.transcription은 파생 캐시로 본다. 확정된 이름은 note_insight, user_memory, 액션 owner로 흐른다.
reason: 완전 자동은 틀린 이름을 확신 있게 적용할 위험이 있고 완전 수동은 입력 최소화 방향과 충돌한다.
paths:
  - src/lib/identifySpeakers.ts
  - src/lib/refreshNoteInsight.ts
  - workflow-server/src/memory.ts
supersedes: []
source: F5_SPEAKER_ID_DESIGN.md "Decisions locked (2026-08-12)" 2번과 3번, "Design principle"
---
## 맥락

화자 확정 시 /refresh-note-insight가 named diarization에서 insight를 다시 추출한다.
