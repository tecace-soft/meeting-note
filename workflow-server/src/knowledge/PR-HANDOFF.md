# Meeting Note private knowledge PR handoff

Review branch: `codex/meeting-knowledge-Hans`; base `main`.
PR: https://github.com/tecace-soft/meeting-note/pull/24
Pair with AXKH: https://github.com/bottomup32/ax-consulting-business/pull/2
The maintainer separately reviews/merges this public producer repository.
All committed fixtures are fictional; no actual private meetings or secrets.

Implemented: verified Microsoft tenant/OID preservation, owner-confirmed
attendance/denial ledger and UI, uncached source authorization and original
fetch, transactional versioned delivery/outbox, policy-gated durable Gemini
candidate extraction, coverage/provenance and bounded provider-attempt accounting.
Source edits/revoke/disable/delete invalidate old work. Candidate extraction
never replaces originals or publishes shared facts. Personal memory is separate.

The owner now sees exact-binding delivery/extraction status, inactive workers,
policy waits, partial coverage and actionable payload/model holds. Explicit
resync recreates missing current source/access events without changing grants,
resetting active leases, replaying completed models or clearing paid limits.
Timeouts settle even noncooperative fetch/body/RPC transports.

Install the five ordered additive knowledge migrations only after comparing
hosted schema and role grants. The final migration is
`20261005012840_meeting_knowledge_owner_operability.sql`; its provider-budget RPC
must precede the new worker. Token exchange/backend precede dependent frontend.
Flags default off, machine keys remain distinct and server-only. See
[BETA-OPERABILITY.md](BETA-OPERABILITY.md), [ROLLOUT.md](ROLLOUT.md),
[EVIDENCE-FETCH.md](EVIDENCE-FETCH.md) and extraction rollout guides.

The wire packet stays 1 MiB with a conservative 900,000 JSON-byte source budget.
Oversized originals remain saved and visibly held; split/edit into a new source
revision. Multipart delivery is not implemented. Automatic paid/ambiguous
provider runs are capped at 3 per immutable source binding, and per-run chunk
bounds still apply. These are beta bounds, not exactly-once billing.

Verification includes full backend tests/build, frontend build, scoped lint,
five migrations applied twice in PostgreSQL-compatible engines, native
PostgreSQL17+PostgREST synthetic roles and separate-connection locking, and the
compiled two-system extraction/import/read boundary. The earlier extraction
runtime now has an independent release audit in addition to the new increment.
Exact final counts are recorded in the PR/QA report.

Real Microsoft SSO/refresh, hosted grants and actual model quality/cost/deployed
latency remain activation gates. There is no staging environment. Local/native
synthetic checks do not establish production sessions. Read-only inspection
found pre-existing public.chat/public.session RLS disabled; review suitable
policies before enabling it, since blanket activation would change existing
flows. No hosted migration, deployment, flags or default-branch merge was applied.

Latest results and evaluation limits: [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).
