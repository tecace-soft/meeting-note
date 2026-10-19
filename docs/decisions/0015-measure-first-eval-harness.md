---
id: DEC-0015
date: 2026-09-02
status: active
question: 메모리와 인덱싱 기능을 더 만들기 전에 무엇을 먼저 할 것인가
options:
  - 효과를 가정하고 계속 구현
  - 라이브 영향을 먼저 측정하고 평가 게이트를 통과한 변경만 출시
chosen: 측정을 먼저 한다. 요약 주입 같은 기능이 도움이 된다고 가정하지 않고 F8(평가 하네스)로 측정한다.
reason: 화자 식별 메모리 A/B가 0.0pt 개선이었다는 선례가 있고, 측정 우선 규율이 화자 식별에서 성과를 냈다.
paths:
  - workflow-server/eval/**
supersedes: []
source: MEMORY_IN_THE_LOOP_DESIGN.md "Decisions locked (2026-09-02)" 3번, "Guiding principles"
---
## 맥락

프롬프트나 메모리 주입을 바꾸는 변경은 eval 하네스로 전후를 비교한 뒤 출시한다.
