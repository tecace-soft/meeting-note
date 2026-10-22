---
id: DEC-0006
date: 2026-08-26
status: active
question: gemini-3.1-flash-lite의 구조화 출력에 중첩 responseSchema를 쓸 것인가
options:
  - 중첩 responseSchema 사용
  - 스키마 없이 프롬프트로 간결한 JSON을 요구하고 파서와 재시도로 검증
chosen: 중첩 responseSchema를 쓰지 않는다.
reason: 측정 결과 중첩 스키마가 3.1-flash-lite를 MAX_TOKENS까지 폭주시켜(약 50초) 30초 abort를 넘겼고, 스키마를 빼면 약 3.4초에 간결한 유효 JSON이 나왔다.
paths:
  - workflow-server/src/routes/transcriptionTest.ts
  - workflow-server/src/ai/geminiFallback.ts
  - workflow-server/src/gemini.ts
  - workflow-server/src/memory.ts
  - supabase/functions/generate-profile/**
supersedes: []
source: docs/API_LESSONS.md, 커밋 c9a5b34 (generate-profile 수정, 2026-08-26)
---
## 맥락

generate-profile의 반복 timeout의 실제 원인이었다.
maxItems 축소, 간결성 지시, timeout 조정, 모델 교체는 모두 증상 수준 조치였다.
