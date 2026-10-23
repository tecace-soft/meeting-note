---
id: DEC-0001
date: 2026-10-19
status: active
question: 사용자 인가의 기준을 무엇으로 삼을 것인가
options:
  - 이메일 또는 이메일 도메인
  - Microsoft tenant id(tid) allowlist + object id(sub / Graph id)
chosen: tenant id allowlist(ALLOWED_MS_TENANT_IDS)와 object id만 신뢰한다. 이메일은 표시용 데이터다.
reason: Entra 테넌트 관리자는 mail 값을 본인 소유가 아닌 주소로 설정할 수 있어 이메일과 도메인은 신뢰할 수 없다.
paths:
  - workflow-server/src/routes/projectChat.ts
  - workflow-server/src/routes/transcriptionTest.ts
  - workflow-server/src/http/identity.ts
  - workflow-server/src/microsoftIdentity.ts
  - workflow-server/src/knowledge/identity.ts
  - workflow-server/src/mcp/lib/microsoftGraph.ts
  - workflow-server/src/mcp/transports/http.ts
  - supabase/functions/supabase-token/**
  - supabase/functions/_shared/verified-microsoft-identity.ts
  - src/context/AuthContext.tsx
  - workflow-server/src/routes/insight.ts
  - workflow-server/src/routes/briefing.ts
  - workflow-server/src/routes/productDocs.ts
  - workflow-server/src/routes/issues.ts
supersedes: []
source: AGENTS.md "Identity trust", 커밋 af6635d (2026-10-19). 원 결정일은 이 커밋 기준.
---
## 맥락

앱 로그인과 백엔드 호출 모두 tid + oid로만 사용자를 식별한다.
mail, UPN, 이메일 도메인으로 접근 허용 여부를 판단하는 코드를 추가하지 않는다.
