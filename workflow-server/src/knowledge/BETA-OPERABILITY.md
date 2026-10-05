# Beta source delivery and processing operations

Install `20261005012840_meeting_knowledge_owner_operability.sql` after the four
meeting-knowledge migrations. Keep workers and integration UI flags disabled
until the corresponding backend/frontend versions are deployed and the two
systems' operator approvals have been checked. Existing hosted jobs require
operator review before enabling the new worker; historical paid usage cannot be
reconstructed from old queue claim counts.

The owner status response optionally includes `processing`: exact current source
binding, raw and JSON-encoded source byte sizes, delivery state, extraction state,
coverage counts and recovery availability. It contains no transcript, candidate
text, model prompt or provider diagnostic. `workers` reports this backend's
configured delivery/extraction flags, independently of the owner's opt-in.
Existing owner-status consumers remain compatible with the older response.

The attendance modal shows processing progress, partial completion, policy waiting,
service inactivity and action-required states. While integration is enabled it
refreshes every five seconds; closing/switching the note cancels requests.
Permission or revision conflicts refresh the owner snapshot without replaying a
mutation. Existing sharing and explicit denial rules are unchanged.

## Owner recovery

`resync` uses the existing authenticated `/knowledge/v1/source-access` management
route. The request binds `sourceId`, `expectedAccessRevision`, `contentRevision`,
`speakerRevision`, `integrationGeneration` and `sourceHash`; identity comes only
from the verified Microsoft-backed JWT. The SQL RPC locks note then source and
checks current ownership, tenant, active/enabled state and all fences.

Recovery recreates missing current source/access envelopes, including historical
ACKs whose pre-migration payload was purged before binding metadata existed. New
outbox metadata survives ACK purge, so repeated recovery cannot duplicate current
pending or delivered envelopes. Explicit recovery is limited to once per source
per 60 seconds. It can advance pending transient delivery retries, preserves
active leases and never changes grants, denials, generations or revisions.

It never reruns completed/partial extraction or clears model budget/payload holds.
Disable/delete/revision mismatch cannot resurrect source data. The RPC is
security invoker, executable only by service_role, with no new anonymous or
browser grants and no newly granted access to the old private snapshot helper.

## Large sources and partial results

The single-packet protocol retains its 1 MiB maximum. A source's JSON-encoded raw
text has a conservative 900,000-byte budget to leave room for spans and envelope
metadata. JSON escaping counts: a small string of control characters can exceed
the transport budget. Both worker and status use this budget; packet size is also
checked after constructing the full envelope. No transcript is silently shortened
or replaced with a summary. The original Meeting Note remains saved.

Oversized sources show an actionable hold: split the raw source into separate
notes or shorten it and save a new revision. Oversized/invalid packets stay held
rather than looping indefinitely. Full-envelope overflow from unusually large
metadata is also visible as `PAYLOAD_TOO_LARGE` and requires operator review.
Large extraction output stays held without repeating paid generation. Partially
completed extraction reports successful/failed/skipped coverage, preserves safe
candidates and keeps raw spans searchable after AXKH read classification approval.

## Model budget and restart behavior

Before the first provider call in a leased extraction run, the worker executes
`meeting_knowledge_extraction_begin_provider`. It validates current source and
lease and records one provider attempt per lease. Multiple chunks in that run do
not increment the run counter again. Policy-denied or unavailable queue claims
that never call the provider do not consume this budget; approval can resume them.
Three paid or ambiguous provider runs for one immutable source binding exhaust
automatic retry budget. A policy revocation after paid work counts too. Completed
partial jobs do not retry. A process restart/lease reclaim must pass the budget
fence before another paid run. A missing budget RPC fails closed.

This is an upper bound on leased paid runs, not exactly-once provider billing.
Each run also respects the configured chunk limit. Administrator review of
purpose approval, prior usage and current source is required for an exhausted
budget; owner resync cannot clear it. There is no uncoordinated new model-retry API.

Delivery fetch/body handling and outbox RPCs have bounded asynchronous deadlines,
including noncooperative injected transports. Late HTTP responses are discarded
and cancelled without ACK. A timed-out SQL RPC might still finish; durable
lease/token/hash/idempotency checks remain authoritative. Shutdown preserves the
lease so another process can recover safely after expiry.

## Verification

From the repository root, with PGlite installed only in a separate test-tools
workspace:

```sh
node workflow-server/scripts/verify-meeting-knowledge-sql.mjs /absolute/path/to/test-tools/node_modules/@electric-sql/pglite/dist/index.js
```

This reapplies all five migrations and checks 35 ledger, 72 outbox, 66 extraction,
33 original-evidence and 49 operability assertions with fixture rollback and UUID
and integer project-array variants. New cases cover exact owner/version recovery,
missing component repair, cooldown/idempotency, metadata preservation, escaped
source sizing, partial counts and unpaid-claim versus paid-run budgets.

Backend tests exercise actual synthetic HTTP owner commands, ignored-abort
fetch/readers, late-response cancellation, RPC deadlines and policy waiting then
approval. Native PostgreSQL 17 and PostgREST synthetic-role checks additionally verify
repeatable migrations, real bigint project IDs, separate-connection locking and
fail-closed reads. Large escaped transcripts use binary change comparison rather
than locale-sensitive JSONB scalar comparison; exact Unicode changes invalidate
bindings while reordered object keys do not. Hosted SSO/grants and real provider
quality/cost remain activation checks. See [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).
Local tests do not activate integration or write hosted data.
