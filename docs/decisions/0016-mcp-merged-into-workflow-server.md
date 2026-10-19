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
supersedes: []
source: RENDER_CONSOLIDATION_DESIGN.md "0. Status update (2026-09-01)", "Option A"
---
## 맥락

mcp-server 브랜치 파이프라인은 폐기됐다.
MCP 변경도 이제 백엔드를 재시작한다(DEC-0003 참고).
