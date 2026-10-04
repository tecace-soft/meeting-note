# Version-bound original evidence

`POST /knowledge/v1/evidence-fetch` is a server-to-server endpoint for checking a
private AXKH citation against the current Meeting Note source. It uses the existing
dedicated `MEETING_KNOWLEDGE_ACCESS_KEY`, fixed `MEETING_KNOWLEDGE_TENANT_ID` and
default-off `MEETING_KNOWLEDGE_ACCESS_ENABLED` flag. It has no browser CORS access.

The request is the complete `MeetingLiveAccessRequest` plus `spanIds` (1–8 unique
IDs). The response echoes that binding and returns only `spans`, each containing
`spanId`, UTF16 `start`/`end`, `textHash` and exact original `text`. Titles, owner
records, other audience members, source links, summaries and model text are absent.
The caller verifies the hash and requested span metadata and must enforce its own
AXKH clearance/classification policy before showing or using these snippets.

Only delivery-generated raw span IDs are accepted. Arbitrary offsets, unknown
spans, stale content/speaker/access/generation/hash bindings, disabled/deleted
sources and audiences without current access fail with the same content-free 404.
Request bodies are bounded to 8 KiB, transcript snapshots to 1 MiB and encoded
responses to 256 KiB. Large or failed reads fail closed rather than truncate.

Apply `20261004194748_meeting_knowledge_evidence_fetch.sql` after the source
ledger/outbox migrations before enabling this endpoint. Its security-invoker RPC
is executable only by `service_role`. It locks the note and then source in the
same order as existing management operations, validates all revisions and checks
confirmed attendance, direct shares or matching-owner project shares. An explicit
deny wins and ownership alone never grants retrieval. No table or stored copy of
the original transcript is introduced.

The handler checks live access before the read and again immediately before
returning snippets. A revocation or edit between those checks invalidates the
entire result. Permissions can change after a successful response; downstream
answer generation must recheck before returning its own result and must not cache
the response as durable authorization.

Verification covers synthetic loopback HTTP, complete binding/ACL cases, UTF16
surrogate boundaries, metadata whitelists, read-time edits/revocations, repeated
migration execution and real PGlite SQL with service-role privileges. PGlite is
single-connection testing; hosted PostgREST/RLS and multi-connection locking tests
remain required before activating this flag. Current Supabase function/privilege
documentation was read through MCP; the changelog markdown fetch returned 403.

Run the committed SQL verifier from the repository root, passing the module from
an isolated PGlite installation outside the application dependencies:

```sh
node workflow-server/scripts/verify-meeting-knowledge-sql.mjs /absolute/path/to/test-tools/node_modules/@electric-sql/pglite/dist/index.js
```

It applies and reapplies all four integration migrations, checks 35 ledger,
72 outbox, 66 extraction and 33 evidence assertions, confirms fixture rollback,
and checks project-share evidence with both historical UUID and integer project
array schemas. It opens only in-memory PostgreSQL engines and uses no connection
string, credential or hosted database.
