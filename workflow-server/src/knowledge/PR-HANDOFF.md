# Meeting knowledge branch review handoff

Review branch: `codex/meeting-knowledge-Hans`, based on `main` (`b829ac3`).
This branch is intended for a draft GitHub PR and Meeting Note maintainer review
before integration. Hosted migrations, deployment and activation remain pending.
Every new integration flag is default off.

## Review scope

The branch contains the shared event contract, opt-in verified Microsoft identity
preservation, private owner/participant/denial ledger, authenticated management
and source-access API, owner attendance UI, transactional delivery outbox and
durable candidate extraction. Existing curated-document ingestion belongs to
AXKH; existing personal-memory extraction remains separate.

The new increment queues extraction only when AXKH ACKs the current raw source.
The worker checks AXKH's explicit model-processing policy, uses the configured
Gemini model with abort and response bounds, then atomically records coverage
and queues candidate units. Edits and lifecycle events cancel stale work. Source
reading permission never supplies model-processing permission. Candidates never
become confirmed/verified facts automatically.

Inspect the three ordered Supabase migrations under `supabase/migrations/` with
names ending in `meeting_knowledge_access_ledger`,
`meeting_knowledge_transactional_outbox`, and `meeting_knowledge_durable_extraction`.
Do not replay unrelated historical migrations without comparing hosted schema
and migration history. Review service-role grants/RLS and note/project trigger
coverage using the deployed schema. Backend API changes precede dependent UI;
the upgraded token exchange's CORS/header support precedes its frontend client.

## Validation and limits

Latest backend suite: 512 passing tests. The PostgreSQL-WASM runner exercises
35 ledger, 72 delivery, 66 extraction and 33 evidence assertions, repeated migrations and
UUID/integer project-array variants. Cross-repository runtime verification
uses two PostgreSQL engines, actual policy/provider/job/delivery code and
in-process Request/Response adapters with synthetic provider replies; 162
assertions pass. It does not call Google, hosted Supabase, or live SSO.

Backend build and changed/new-file lint pass. Existing whole-repository lint
failures are not fixed by this branch. Prior actual-modal functional browser
verification passed 41 synthetic-auth assertions; no UI changed in the durable
extraction increment. Final independent review of this increment was interrupted
by agent usage limits; root completed tests and manual review, but independent
release review remains pending. Earlier PR2/core QA does not approve these new
runtime changes for release. PR4 original-evidence/search has a separate
independent review and actual-localhost-HTTP verification; it does not replace
that earlier runtime release review.

No staging exists. Before activation, validate native PostgREST/RLS, real
Microsoft users/tokens, simultaneous worker connections, edit/delete races,
provider policy/quality/cost, rollback and actual application regression flows.

## Maintainer activation dependencies

See `ROLLOUT.md`, `EXTRACTION.md`, `EXTRACTION-PROVIDER.md` and
`EXTRACTION-ROLLOUT.md`. AXKH's private receiver/policy schema and dedicated
keys must be ready before producers are enabled. The first policy implementation
uses explicit per-revision operator approval; project defaults and a human
classification UI are future work. A partial run stores failed/skipped coverage
and raw fallback; there is no automatic failed-chunk resume or multipart packet
delivery. Document/entity search and role views are not implemented here.

The next increment adds `/knowledge/v1/evidence-fetch`, using the same dedicated
access key/tenant/default-off access flag and a service-only additive migration.
It returns at most eight exact delivery spans only when all source versions and
current participant/share access match; management ownership alone never grants
retrieval. See `EVIDENCE-FETCH.md`. AXKH's `codex/meeting-knowledge-search-Hans`
branch contains the companion
private read classification, document/meeting search page and Web/MCP evidence
reads. That search is an excerpt baseline; role views and synthesis are pending.
