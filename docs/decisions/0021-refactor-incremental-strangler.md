---
id: DEC-0021
date: 2026-10-21
status: active
question: "#14 리팩터링을 전면 재작성으로 할 것인가, 점진적으로 할 것인가"
options:
  - 전면 재작성(새 구조로 다시 만들고 한 번에 교체)
  - 점진적 strangler(경로 단위로 모듈을 추출하고 단계마다 동작을 보존하며 배포)
chosen: 점진적 strangler를 기준안으로 한다. index.ts는 handle<Group>Request 한 줄 dispatch로 경로 단위 추출하고, 웹은 src/lib/<domain>/ repository로 데이터 접근을 모은다. 단계마다 특성화 테스트, 라우트 parity, 롤백을 갖춘다. 2026-10-21 Andrew 승인("고치면서 새 모습으로", 백엔드는 단계적 교체, 화면과 흐름은 재설계, 서버는 무료 플랜 유지). 뒤집히면 대체 결정을 기록한다.
reason: 2026-10-09 리뷰의 다섯 관점이 모두 재작성은 정당화되지 않는다고 결론냈다. 신뢰성 처리(heartbeat, orphan sweep, 멱등성, 재시도)가 이미 코드에 있고, knowledge와 mcp가 같은 seam으로 운영 중이다. 문제는 god-file과 중복 호출부에 몰려 있어 기계적으로 추출할 수 있다.
paths:
  - workflow-server/src/routes/issues.ts
  - workflow-server/src/issueLinks.ts
  - workflow-server/src/issues.ts
  - workflow-server/src/routes/transcriptionTest.ts
  - workflow-server/src/ai/**
  - workflow-server/src/pipeline/**
  - workflow-server/src/parsers.ts
  - workflow-server/src/http/**
  - workflow-server/src/db/**
  - workflow-server/src/index.ts
  - workflow-server/src/config/**
  - src/pages/Project.tsx
  - src/lib/notes/repository.ts
  - src/pages/SummaryHistory.tsx
supersedes: []
source: docs/reviews/2026-10-09-renovation-review.md Verdict, docs/refactor/REFACTOR_PLAN.md, 2026-10-19 회의(안정성 우선, 필요하면 재설계, 자동화 최대화)
---
## 맥락

실행 계획과 진행 상태는 docs/refactor/REFACTOR_PLAN.md가 정본이다.
index.ts에 새 라우트나 새 최상위 함수를 추가하지 않는다.
이동 커밋은 오류 문구, 라우트 순서, 응답 형태를 바꾸지 않고, 동작 변경은 별도 커밋으로 한다.
재설계 영역을 따로 지정하면 그 영역만 별도 결정으로 다룬다.
