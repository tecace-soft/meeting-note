---
id: DEC-0026
date: 2026-11-04
status: active
question: Decision Graph 추출을 어디에 어떻게 붙일 것인가
options:
  - AXKH meeting-knowledge 추출 파이프라인(workflow-server/src/knowledge)을 확장
  - finalize 단계에 별도 Job A를 두고 mn_* 테이블에 저장하며 feature flag로 기본 off
chosen: finalize 단계의 별도 Job A와 mn_* 테이블. status 8종은 DB check와 스키마 검증으로 고정하고, 읽기는 note RLS를 상속하며 민감 데이터는 note 소유자만 본다. 쓰기는 service_role 전용 SQL 함수로만 하고 human_verified 행은 재추출에서 보존한다. 모델은 lite 2종만 비교한다.
reason: knowledge 계약 파일은 AXKH와 byte-identical이어야 해서 바꿀 수 없다(DEC-0018). note_insight와 같은 위치(finalize)와 호출 경로(callJsonModel)를 쓰면 기존 재시도·lite 정책을 그대로 따른다. 참석자 oid가 없어 참석자 기반 공개는 신원 신뢰 규칙(DEC-0001)상 아직 불가하다.
paths:
  - workflow-server/src/decisions/**
  - supabase/migrations/20261104120000_create_decision_graph.sql
  - workflow-server/eval/decision-graph.ts
supersedes: []
source: 2026-11-01 Hans Lee handoff (Decision Graph 저장 기능 개발 요청), docs/decision-graph.md
---
## 맥락

handoff는 2~3개 모델 비교를 요구하지만 DEC-0005가 lite 모델만 허용하므로 2.5/3.1 flash-lite만 비교한다.
비-lite 모델이 필요하면 DEC-0005를 대체하는 결정을 먼저 기록한다.
프롬프트를 바꾸면 DECISION_PROMPT_VERSION을 올린다. (note_id, prompt_version) 기준 멱등이라 버전이 바뀌어야 재추출된다.
