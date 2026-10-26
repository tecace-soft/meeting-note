---
id: DEC-0008
date: 2026-08-04
status: active
question: 화자 식별에 어떤 신호를 쓸 것인가
options:
  - 음성 생체 인식(클라우드 유료, 자체 호스팅, 온디바이스)
  - 텍스트와 컨텍스트 기반 LLM 매칭(기존 Gemini 재사용)
chosen: 텍스트와 컨텍스트(identify-speakers, user_memory, speaker.profile, MS 참석자)만 쓴다. 음향 voiceprint는 저장하지 않는다.
reason: Azure Speaker Recognition이 2025-09에 폐기되어 저렴한 관리형 옵션이 없고, 자체 호스팅은 상시 컴퓨트 비용이 든다. 무료 텍스트 접근을 먼저 출시하고 측정한다.
paths:
  - workflow-server/src/routes/insight.ts
  - workflow-server/src/pipeline/speakerContext.ts
  - workflow-server/src/speakerAnchors.ts
  - workflow-server/src/speakerSignature.ts
  - supabase/functions/identify-speakers/**
  - src/lib/identifySpeakers.ts
  - workflow-server/src/pipeline/finalize.ts
supersedes: []
source: MEMORY_FEATURE_DESIGN.md "Decisions (2026-08-04)", F5_SPEAKER_ID_DESIGN.md "Decisions locked (2026-08-12)" 1번
---
## 맥락

F5_SPEAKER_ID_DESIGN.md가 전제를 바로잡았다.
시스템은 이미 컨텍스트 기반이고 음향 정체성은 어디에도 저장되지 않는다.
