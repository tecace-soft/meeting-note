---
id: DEC-0004
date: 2026-07-23
status: active
question: Supabase service role key를 어디까지 노출할 것인가
options:
  - 프런트엔드(VITE_* 변수)에서도 사용
  - 서버 전용으로만 사용
chosen: SUPABASE_SERVICE_ROLE_KEY는 서버 전용이며 VITE_* 나 프런트엔드 코드에 두지 않는다. .env는 커밋하지 않는다.
reason: VITE_* 값은 번들에 포함되어 공개되고, service role key는 RLS를 우회한다.
paths:
  - workflow-server/src/routes/projectChat.ts
  - workflow-server/src/db/supabaseClient.ts
  - .env.example
  - workflow-server/.env.example
  - vite.config.ts
  - src/config/supabaseConfig.ts
supersedes: []
source: AGENTS.md "Secrets" (커밋 5c44c39 시점부터 존재)
---
## 맥락

실제 값은 Render, Supabase, Azure 대시보드에만 둔다.
이 결정 파일에도 비밀 값을 적지 않는다.
