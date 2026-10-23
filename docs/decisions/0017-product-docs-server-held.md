---
id: DEC-0017
date: 2026-10-13
status: active
question: 에이전트용 제품 문서를 어디에 두고 어떻게 노출할 것인가
options:
  - 공개 정적 .md 서빙
  - 인증 뒤 프런트 번들에 본문 포함
  - 앱 내 편집 UI와 DB 저장
  - 서버가 본문을 보유하고, 웹 API와 MCP 툴이 같은 로더와 같은 권한검사를 호출
chosen: 문서 본문의 단일 출처는 서버이며, 사람은 인증된 웹 경로로, 에이전트는 MCP 툴(get_product_docs)로 읽는다. 두 경로가 같은 로더와 권한검사를 쓴다.
reason: 공개 서빙은 내부 명세를 무인증으로 노출하고, 프런트 번들 포함은 정적 JS에서 본문을 추출할 수 있어 비공개가 아니다. 서버 단일 출처가 본문 일치와 소스 단일화를 보장한다.
paths:
  - workflow-server/src/routes/productDocs.ts
  - workflow-server/src/productDocs.ts
  - workflow-server/src/mcp/tools/productDocs.ts
  - src/lib/productDocs.ts
  - src/pages/ProductDocs.tsx
supersedes: []
source: AGENT_DOCS_DESIGN.md "3.0 권장 아키텍처", "5. 검토한 대안과 기각 이유"
---
## 맥락

문서 신선도는 manifest.json의 body hash와 depends_on으로 검증한다(docs:check).
