---
id: DEC-0009
date: 2026-08-12
status: active
question: 화자별 음향 임베딩(voiceprint)을 구축할 것인가
options:
  - 별도 임베딩 모델과 벡터 저장소로 모든 녹음을 처리
  - 영구히 순수 컨텍스트 방식 유지
chosen: F5.4 음향 임베딩은 보류가 아니라 폐기한다. 컴퓨트 경제성이 크게 바뀌지 않는 한 재검토하지 않는다.
reason: AssemblyAI는 임베딩을 주지 않아 모든 녹음에 별도 모델과 벡터 저장소가 필요하고, 컴퓨트 비용이 정당화되지 않는다.
paths:
  - workflow-server/src/speakerSignature.ts
  - supabase/functions/identify-speakers/**
supersedes: []
source: F5_SPEAKER_ID_DESIGN.md "F5.4 Acoustic voice embeddings [DROPPED 2026-08-12]"
---
## 맥락

DEC-0008을 보강한다.
화자 식별을 위해 새 음향 모델이나 벡터 저장소를 도입하려면 먼저 이 결정을 대체하는 결정을 기록한다.
