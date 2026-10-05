# First-beta validation record

## Verification on 2026-10-05

- AXKH full suite: 1,801 passed, 2 existing skipped tests; typecheck and changed-code lint passed.
- Meeting Note backend full suite: 522 passed; backend and frontend builds passed.
- AXKH production build passed compilation, TypeScript, all 107 static pages and route generation with explicit synthetic loopback DB/API/SSO configuration. This is compiler verification, not production login.
- Native PostgreSQL 17.11: all five source migrations applied twice, 255 SQL assertions, real bigint project IDs, two-connection locking, stale evidence and browser-role denials. The regression also checks a 460,000-newline update under a 5-second statement deadline, exact Unicode changes and equivalent JSON object key ordering.
- Native PostgREST 13.0.8: 12 synthetic JWT/role/binding/schema-isolation checks. These JWTs do not establish Microsoft authentication.
- Review SQL: 72 assertions plus 19 actual review-DAL assertions; semantic SQL: 32 assertions; private-vector native runtime: 16 assertions. Private indexing/save/reuse/cosine/access-denial/revocation/purge use native SQL and synthetic provider responses.
- Independent audit: previous durable extraction runtime plus the beta increment, including a compiled two-engine 162-assertion ACK/policy/adapter/units pipeline, component workflow and denial checks, KO/EN and mobile checks. Actual Next production font responses and loaded local families passed; no external font requests.
- Version is 0.41.0 in all three AXKH release files. Six producer/consumer contract files are byte-identical. Seventeen font/provenance files have checked SHA-256s, with six pinned upstream archive integrities.

## Retrieval experiments and their limits

The committed fictional evaluator runs 20 fixed questions and 8 held-out fictional
questions (40 test cases). Source recall is 100% in both sets. Listed-gold
precision is 39.0% / 42.7% and MRR is 1.0 / 0.875; the labels intentionally omit
some related context, so listed-gold precision is a noise diagnostic rather than
verified relevance or answer accuracy.

An existing private six-meeting corpus stays outside both repositories. Its
frozen 20-question native-SQL experiment retrieved the expected source in 19/20
questions and all listed markers in 17/20, with MRR 0.7125 and mean returned
context 28,423 characters. These are diagnostic results on previously available
data, not an independent real-data holdout or proof of a best design. No real
Gemini extraction/embedding/brief call was measured in these checks. Actual
model quality, cost, multilingual vector relevance and deployed latency remain
activation gates.

## Activation checks

There is no staging environment. Before turning on flags, validate real
Microsoft multi-user login/refresh, clearance/roles, source attendance/sharing,
paired endpoints, hosted schema and runtime/operator grants, and real provider
quality/cost/latency. All new feature flags remain off by default. No hosted
migration, approval, deployment, activation or default-branch merge was performed.

Read-only inspection of the hosted Meeting Note project found existing
`public.chat` and `public.session` tables with RLS disabled. The new private
feature tables have RLS; they do not repair those pre-existing tables. Review
appropriate policies against existing application flows before activation:
[Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).
No blanket RLS change was applied.

Existing repository-wide lint failures remain outside this change; changed-code
lint passes. Local provider and browser transports are synthetic. Source/HR/
policy/document checks are separate current checks rather than a distributed
atomic snapshot, and already returned client text cannot be recalled.

## Reproduction

Run `npm test` and `npm run build` inside `workflow-server`, then the frontend
build at the repository root. The three committed runners in
`workflow-server/scripts/verify-meeting-knowledge-{sql,native,postgrest}.mjs`
accept an isolated PGlite path or explicitly labelled local Docker containers,
never a hosted database URL. Native runs require fresh synthetic database names;
PostgREST checks run after native fixture setup. See
[BETA-OPERABILITY.md](BETA-OPERABILITY.md) and [ROLLOUT.md](ROLLOUT.md).
All committed meetings, labels, JWTs and provider responses are fictional.
