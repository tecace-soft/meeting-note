---
id: DEC-0005
date: 2026-08-18
status: active
question: 프로덕션에서 어떤 Gemini 모델을 어떻게 지정할 것인가
options:
  - 필요에 따라 비-lite 상위 모델도 사용하고 모델 id를 코드에 흩어서 적음
  - lite 모델만 사용하고 모델 id를 한 파일에 고정하며 drift 테스트로 지킴
chosen: gemini-2.5-flash-lite 또는 gemini-3.1-flash-lite만 쓰고, id는 gemini-models.ts에만 두며 drift 테스트(npm test)를 통과시킨다. 폴백 체인은 살아있는 lite 모델로 끝나야 한다.
reason: 팀의 엄격한 비용 제한이 있고, 퇴역한 모델 id(gemini-2.0-*)가 edge function 404를 일으켰다. 더 큰 모델이 화자 구분력을 개선하지 않는다는 bakeoff 결과도 있다.
paths:
  - workflow-server/src/routes/regenerateSummary.ts
  - workflow-server/src/pipeline/promptLoaders.ts
  - workflow-server/src/routes/transcriptionTest.ts
  - workflow-server/src/ai/geminiFallback.ts
  - workflow-server/src/gemini-models.ts
  - workflow-server/src/gemini.ts
  - supabase/functions/identify-speakers/**
  - supabase/functions/generate-profile/**
  - docs/API_LESSONS.md
supersedes: []
source: docs/API_LESSONS.md (비용 정책, 모델 고정, bakeoff 2026-08-26), 커밋 4d0348f의 edge function lite-only 수정
---
## 맥락

Gemini 호출을 추가하거나 바꾸기 전에 docs/API_LESSONS.md를 읽는다.
