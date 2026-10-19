---
id: DEC-0014
date: 2026-09-02
status: active
question: 사용자가 메모리를 어느 정도까지 직접 편집하게 할 것인가
options:
  - 확인/거부 리뷰 큐 도입
  - 전체 편집 UI
  - 메모리는 자동 관리하고 사용자 쓰기는 삭제만 허용
chosen: 메모리는 자동 관리하며 사용자가 할 수 있는 쓰기는 삭제뿐이다. 품질은 supersede와 consolidation 같은 자동 메커니즘으로 확보한다.
reason: 회의마다 메모리를 검토하고 승인하게 하면 입력 최소화 방향과 충돌하고 대부분의 사용자는 하지 않는다. 자동 품질이 부족하다고 측정될 때만 편집 UI를 재검토한다.
paths:
  - src/components/UserMemoryView.tsx
  - src/lib/userMemory.ts
supersedes: []
source: MEMORY_IN_THE_LOOP_DESIGN.md "Decisions locked (2026-09-02)" 2번
---
## 맥락

메모리 기능에 승인 큐나 필수 사용자 입력 단계를 추가하려면 이 결정을 먼저 대체한다.
