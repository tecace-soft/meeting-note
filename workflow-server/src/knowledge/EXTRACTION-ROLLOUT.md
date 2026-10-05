# Durable candidate extraction rollout

No hosted migration, model call, flag activation or deployment is performed by
these files. Apply the source/identity/outbox rollout prerequisites first.

## Dependency order

1. Review the additive AXKH model-policy migration and private import migration.
   Deploy the receiver and keep `MEETING_KNOWLEDGE_MODEL_POLICY_ENABLED` off.
   Its dedicated key must differ from both ingest and source-access keys.
2. Review the Meeting Note durable-extraction migration after the existing
   ledger/outbox migrations. It queues jobs only after a current source ACK and
   preserves earlier migration files. All job tables and RPCs are service-only.
3. Deploy the backend transport/provider code before activating the worker.
   Existing frontend and personal-memory generation do not enable it.
4. Verify real schema/roles/RLS/PostgREST, actual Microsoft identities, expired
   tokens, two simultaneous worker connections and edit/delete/disable races.
   Local single-connection PostgreSQL-WASM tests cannot establish these results.
5. After permitted source enrollment/delivery, approve an exact AXKH processing
   policy following AXKH's operator runbook. The policy endpoint never approves
   requests itself. Do not substitute operator DB permission for a user's read
   permission. Initial per-revision approvals are intentionally conservative;
   project defaults and classification UI are not yet implemented.
6. Validate provider terms, approved model, real quality/cost and retention.
   Then enable a limited worker and compare private candidates with original
   evidence. Search/shared graph exposure remains disabled independently.

## Server configuration

The existing service-role Supabase client and `GEMINI_API_KEY` (existing
`GOOGLE_API_KEY` compatibility fallback) stay server-only. Required new settings:

- `MEETING_KNOWLEDGE_EXTRACTION_ENABLED=true`: opt-in; delivery must also be on.
- `MEETING_KNOWLEDGE_EXTRACTION_MODEL`: explicit plain `gemini-*` ID; no fallback.
- `MEETING_KNOWLEDGE_MODEL_POLICY_KEY`: third dedicated random bearer secret.
- Existing `MEETING_KNOWLEDGE_AXKH_URL` and `MEETING_KNOWLEDGE_TENANT_ID`.
- `MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS`: optional 1–64, default 16. Unprocessed
  remainder has skipped coverage and raw fallback; it does not vanish.

Malformed configuration emits only `CONFIG_UNAVAILABLE` and leaves existing
transcription/MCP startup running. There are no new frontend secrets or flags.

## Recovery, data and limits

The persistent job is bound to the ACKed source event, not an editable summary.
Failed processing approvals retry with bounded backoff. A lease lost during
generation discards the result. A crash restarts an unfinished whole job; native
provider work may already have been billed. The worker's renew/current checks
and SQL completion fence prevent stale workers from completing another lease.

Completion stores only validated coverage and run provenance in the job; its
raw snapshot is cleared. Candidate data and exact source context are held in
the private units outbox until ACK/cancellation. An oversized extraction
completion preserves its job with `PAYLOAD_TOO_LARGE` and infinite availability
time: it is not automatically sent back to the model repeatedly. Repair capacity
or operating budgets before an operator makes that job eligible again. Already
queued oversized delivery packets are retained with the same safe error code.
There is no multipart delivery. Operator remediation/backfill is required
rather than truncating evidence or discarding pending work. A model's incomplete or failed chunk has explicit fallback;
completed partial runs have no automatic per-chunk retry yet.

Stop the extraction worker before removing its SQL. Stop new model calls by
revoking the AXKH processing policy and disabling the extraction flag. Already
running provider work may not be cancellable immediately. Policy revocation
does not erase previously stored candidates or replace read authorization.
To purge replicated meeting content, explicitly disable/delete the source and
drain its lifecycle event before turning off delivery/import. Preserve receipt
and tombstone metadata; do not restore deleted data during rollback.

## Validation scope

Offline provider tests use synthetic Google-shaped responses; no real model is
called. In-process HTTP adapters exercise real Request/Response bodies and both
database engines but replace hosted PostgREST and network transport. No real
meeting corpus is committed to the public repository. Native model quality,
actual multi-user SSO, production capacity and multi-connection behavior remain
unverified.
