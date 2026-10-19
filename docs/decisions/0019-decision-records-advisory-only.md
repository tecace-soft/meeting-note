---
id: DEC-0019
date: 2026-10-19
status: active
question: 흩어진 결정을 어떻게 에이전트가 모르고 어기지 않게 할 것인가
options:
  - AGENTS.md에 규칙을 계속 추가
  - 구조화된 결정 기록과 path glob 기반 권고 검사를 만들고 CI에서 경고만 한다
chosen: docs/decisions/에 결정 1건당 1파일로 기록하고, 변경 파일이 active 결정의 paths와 겹치면 권고 경고를 낸다. 경고만 하며 절대 차단하지 않는다(형식 오류인 결정 파일만 실패).
reason: AGENTS.md는 짧게 유지해야 하고, 결정은 설계 문서에 흩어져 있어 에이전트가 놓친다. glob이 넓으면 경고 피로로 무시되므로 결정마다 좁게 쓴다.
paths:
  - scripts/decisions/**
  - .github/workflows/decisions-advisory.yml
  - docs/decisions/README.md
supersedes: []
source: AXKH_NODE_AND_DECISIONS_PLAN.md D4, Phase 1
---
## 맥락

active 결정과 모순되는 변경은 먼저 대체 결정을 기록한다.
