---
id: DEC-0011
date: 2026-08-27
status: active
question: 화자 구분력(같은 팀 내 혼동)을 어떻게 높일 것인가
options:
  - 프롬프트만 조정
  - 단일 identify 호출 위에 결정적 증거 앵커 레이어를 둔다
chosen: 순수 모듈 speakerAnchors.ts(extractAnchors, applyAnchors)를 identifySpeakers 파싱 직후에 적용하고, 웹 UI용 edge function 사본과 동작을 동일하게 유지한다.
reason: 프롬프트 조정은 이미 시도했으나 within-roster 혼동을 고치지 못했다. 앵커 로직은 순수 문자열 처리라 결정적이고 단위 테스트가 가능하며 backtest로 재현된다.
paths:
  - workflow-server/src/speakerAnchors.ts
  - workflow-server/src/memory.ts
  - supabase/functions/identify-speakers/**
supersedes: []
source: SPEAKER_DISCRIMINABILITY_DESIGN.md 2절, 7절 (날짜는 인접 설계 문서 기준 추정, 재확인 필요)
---
## 맥락

서버와 edge function 두 사본은 동작이 같아야 한다.
한쪽만 바꾸면 웹과 모바일 결과가 갈라진다.
