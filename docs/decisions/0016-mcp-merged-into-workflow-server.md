---
id: DEC-0016
date: 2026-09-01
status: active
question: Render 무료 티어 750시간 초과를 어떻게 해결할 것인가
options:
  - MCP를 workflow-server에 합쳐 Render 웹 서비스 1개로 운영(옵션 A)
  - MCP를 서버리스 호스트로 이전(옵션 B)
  - 백엔드를 webhook 방식으로 바꿔 상시 가동을 없앰(옵션 C)
chosen: MCP를 workflow-server 프로세스에 합친다. handleMcpRequest가 요청 핸들러에서 가장 먼저 경로를 소유하고(/mcp, /mcp-chatgpt, /.well-known/oauth-protected-resource*), 나머지는 기존 백엔드 라우트로 넘긴다. 배포는 main 하나에서 한다.
reason: 상시 가동 Node 서비스가 둘이라 월말에 750시간을 넘겨 중단됐다. 합치면 서비스가 하나(약 730시간)이고 코드 재사용이 가능하며 추가 비용이 없다.
paths:
  - workflow-server/src/mcp/transports/**
  - workflow-server/src/mcp/server.ts
  - workflow-server/src/http/router.ts
supersedes: []
source: RENDER_CONSOLIDATION_DESIGN.md "0. Status update (2026-09-01)", "Option A"
---
## 맥락

mcp-server 브랜치 파이프라인은 폐기됐다.
MCP 변경도 이제 백엔드를 재시작한다(DEC-0003 참고).
MCP를 연결하는 dispatch는 workflow-server/src/http/router.ts에 있고, 코드 순서는 knowledge 경로, OPTIONS, handleMcpRequest, 호스트 라우트다(위 "가장 먼저"는 호스트 라우트보다 먼저라는 뜻).
router-contract.test.ts는 knowledge, OPTIONS, MCP의 순서와, MCP가 자기 경로만 답하고 /health, /version, /admin/backfill-insight는 호스트로 넘긴다는 점을 고정한다.
MCP 경로와 호스트 라우트가 함께 맞는 경로는 지금 없으므로 MCP와 호스트 라우트 사이의 순서는 테스트로 관찰되지 않는다.
