---
id: DEC-0018
date: 2026-10-19
status: active
question: AXKH 연동 플랜에서 계약 파일과 전송 시점을 어떻게 다룰 것인가
options:
  - 녹음 후 자동 전송하고 계약을 필요에 맞게 변경
  - 노트별 opt-in과 사용자 클릭 전송을 유지하고 계약 파일은 변경하지 않음
chosen: 녹음 후 자동 전송은 하지 않는다(요약 후 눈에 띄는 원클릭 버튼만 제공). contract.ts 등 계약 파일은 AXKH 저장소와 byte-identical이어야 하므로 이 플랜에서 변경하지 않는다. 기존 knowledge 파이프라인(outbox, ACK, 접근 검사, 추출)은 유지한다.
reason: AXKH 쪽 승인을 제거하면 노트별 opt-in(integration_enabled 기본 꺼짐)과 참석자/공유 권한이 유일한 방어선이 되며, 자동 전송 금지가 이를 지킨다.
paths:
  - workflow-server/src/knowledge/contract.ts
  - workflow-server/src/knowledge/access-contract.ts
  - workflow-server/src/knowledge/evidence-contract.ts
  - workflow-server/src/knowledge/event.schema.json
  - workflow-server/src/knowledge/outbox.ts
  - src/services/meetingKnowledge.ts
  - src/components/MeetingKnowledgeModal.tsx
supersedes: []
source: AXKH_NODE_AND_DECISIONS_PLAN.md D1, D2, 3절 마지막 항목, 6절 위험
---
## 맥락

계약 변경이 필요하면 AXKH 저장소와 함께 조정하고 이 결정을 대체한다.
