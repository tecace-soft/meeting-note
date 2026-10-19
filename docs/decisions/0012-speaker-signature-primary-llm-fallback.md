---
id: DEC-0012
date: 2026-08-27
status: active
question: 화자 시그니처를 어디서 어떻게 계산하고 LLM과 어떻게 결합할 것인가
options:
  - 저장된 speaker.signature 컬럼(마이그레이션 필요)
  - identify-speakers edge function에서 즉석 계산
  - 임베딩 기반 표현
chosen: 제안 시점에 edge function이 최근 라벨 노트로 즉석 계산하고, 시그니처 우선(signature-primary)에 LLM은 콜드스타트나 약한 신호에서만 폴백한다. v1 표현은 TF-IDF bag-of-words cosine이다.
reason: 마이그레이션 없이 항상 최신이고 가용성을 유지하며 비용이 없고 결정적이다. 임베딩은 측정된 정체가 있을 때만 검토한다.
paths:
  - workflow-server/src/speakerSignature.ts
  - supabase/functions/identify-speakers/**
supersedes: []
source: SPEAKER_SIGNATURE_DESIGN.md "2. Decisions locked" (문서 상태는 PLAN, 구현 범위는 코드로 재확인 필요)
---
## 맥락

저장 컬럼 방식은 검증 후의 후속 최적화로만 남겨 둔다.
