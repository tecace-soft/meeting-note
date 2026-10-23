---
id: DEC-0013
date: 2026-08-06
status: active
question: 사용자 개인 메모리를 어떤 구조와 갱신 의미로 저장할 것인가
options:
  - 고정 타입 버킷(action items, collaborators, projects, topics)과 append-only
  - 내러티브 메모리 노트를 주 계층으로 하고 update/supersede 방식으로 갱신(이후 관계 그래프를 아래에 추가)
chosen: 내러티브 메모리를 사람이 읽는 주 계층으로 두고 갱신은 append가 아니라 update/supersede로 한다. 관계 그래프는 F4 인덱스와 함께 후속으로 쌓는다.
reason: 2026-08-06 팀 리뷰 피드백이 CRM 덤프 같은 사실 중심 메모리 대신 컨텍스트와 관계 중심의 장기 메모리를 요구했다.
paths:
  - workflow-server/src/routes/regenerateSummary.ts
  - workflow-server/src/pipeline/promptLoaders.ts
  - workflow-server/src/pipeline/memoryContext.ts
  - workflow-server/src/memory.ts
  - src/lib/userMemory.ts
  - src/components/UserMemoryView.tsx
supersedes: []
source: MEMORY_FEATURE_DESIGN.md "F1' Dynamic relational memory", Direction (locked 2026-08-06)
---
## 맥락

supersede는 항목 id를 유지하는 in-place 텍스트 교체와 출처 기록으로 구현됐다.
상한은 ACTIVE_CAP=50, TOTAL_CAP=80이다.
