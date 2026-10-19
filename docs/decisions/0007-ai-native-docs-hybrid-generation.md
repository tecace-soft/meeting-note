---
id: DEC-0007
date: 2026-10-08
status: active
question: AI-native 문서(docs/ai-native)를 어떻게 최신으로 유지할 것인가
options:
  - GitHub Action 등 클라우드 CI에서 생성
  - pre-commit 훅이 결정적 스크립트를 돌리고, 서술은 에이전트가 /update-docs로 작성
chosen: 구조는 네트워크와 LLM 없이 Node 내장만 쓰는 결정적 생성기가 마커 사이만 다시 쓰고, 서술과 결정 기록은 에이전트가 쓴다. 트리거는 커밋된 pre-commit 훅이다.
reason: 훅은 API 키 없이 매 커밋에서 안전하게 돌고, 문서가 구조를 바꾼 같은 커밋에 실린다. 클라우드 CI는 별도 Claude API 키가 필요하고 결정적 부분에 도움이 안 된다.
paths:
  - scripts/ai-native-docs/**
  - .githooks/**
  - docs/ai-native/intro.md
supersedes: []
source: docs/ai-native/decision.md "2026-10-08: AI-native documentation automation"
---
## 맥락

history.md의 자동 영역은 손으로 편집하지 않는다.
훅은 생성기 종료 코드를 무시하므로 문서 생성이 커밋을 막지 않는다.
