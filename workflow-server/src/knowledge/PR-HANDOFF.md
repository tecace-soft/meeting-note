# Meeting knowledge branch review handoff

Branch: `codex/meeting-knowledge-contract`, based on `main` (`b829ac3`). Changes
are local commits; no GitHub PR, remote push, hosted migration or deployment has
been performed. Coordinate review with the Meeting Note maintainer before
integration. Every new integration flag is default off.

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

Latest backend suite: 505 passing tests. The PostgreSQL-WASM runner exercises
35 ledger, 72 delivery and 66 extraction assertions, repeated migrations and
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
runtime changes for release.

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
