# Private source access ledger and HTTP routes

The new routes run in the existing Node workflow server before its generic CORS
and legacy MCP dispatch. They are disabled by default. Hosted configuration,
database schema and user meetings have not been changed. The new owner UI,
outbox and export worker are implemented behind separate disabled flags. No
search, model, document-ingest or new MCP consumer is activated by this increment.

## Database boundary

`supabase/migrations/20261004034140_meeting_knowledge_access_ledger.sql` was created
with Supabase CLI `migration new`. It creates a private `meeting_knowledge` schema
with RLS on source, participant, denial and access-event tables. Neither browser
role receives schema/table access or execution of the new public RPCs. The three
public RPCs are SECURITY INVOKER and service-only. The server uses its existing
private service-role client and a separate two-second RPC abort deadline.

Only private trigger functions use SECURITY DEFINER, with an empty search path,
fully qualified tables and no direct execution grants. This lets existing
RLS-authorized browser edits update private revisions without granting browser
access to the ledger. Enrollment does not enable integration. It checks the
actual note owner against the server-verified JWT object ID and permanently binds
the verified tenant. Management ownership alone does not grant evidence reading.

The loader reads raw transcript, original shares and ledger state in one SQL
snapshot. It returns identities, versions and an exact UTF-8 SHA256, never the
transcript, summary or title. Legacy lowercase UUID shares are scoped to the
verified note owner's tenant; names, email aliases and malformed share entries
are excluded. Eligible project shares require the same original note/project
owner. Explicit deny overrides attendance and both share routes. Attendance
confirmation cannot clear a deny; restore removes a deny without creating a grant.

Triggers track raw transcript/diarization, speaker, note membership/share and
project share/ownership changes. Summary edits do not pretend to alter historical
speech. Speaker profiles lack per-note foreign keys, so a profile change currently
invalidates all enrolled sources of that owner conservatively. Empty or
diarization-only transcripts are withheld; a later canonical export must preserve
the exact hashed text before such notes can enter the pipeline.

Deletion or owner/ID reassignment permanently tombstones the old source. Reusing
an ID or returning to the old owner cannot reactivate its grants. Disable/enable
uses a new integration generation. Access commands require the current revision;
a retry with an old revision gets409 and must read the current state. Identical
commands at the current revision are no-ops. Retained access events record actual
changes; they contain no meeting speech or names.

## Server configuration and API

Blank new settings are in `workflow-server/.env.example`:

| Setting | Use |
| --- | --- |
| `MEETING_KNOWLEDGE_ACCESS_ENABLED` | Exact `true` opens the service access-check route; default404 |
| `MEETING_KNOWLEDGE_ACCESS_KEY` | Dedicated random server Bearer secret,32–512 compatible ASCII characters, shared only with AXKH |
| `MEETING_KNOWLEDGE_TENANT_ID` | One canonical lowercase allowed tenant UUID for this integration |
| `MEETING_KNOWLEDGE_MANAGEMENT_ENABLED` | Separate exact `true` opens owner-management; default404 |
| `SUPABASE_JWT_SECRET` | Existing server-only token-exchange signing secret, at least32 UTF-8 bytes |
| `ALLOWED_MS_TENANT_IDS` | Explicit tenant allowlist for verified owner JWTs |
| `APP_FRONTEND_ORIGIN` | Explicit frontend origin for browser owner-management CORS; wildcard is rejected |

Never reuse the integration key as a JWT signing secret or legacy MCP key. Server
key shape is32 UTF-8 bytes minimum,512 characters maximum, using
`[A-Za-z0-9._~+/-]` with up to two trailing `=` characters. Generate a random key
outside code and provision server-only settings to both hosts. Missing enabled
configuration fails503; no default key or guessed tenant is accepted.

`POST /knowledge/v1/access-check` uses `Authorization: Bearer <integration key>`
and the exact eight-field shared `MeetingLiveAccessRequest`. Other tenants are
rejected before DB access. It returns the same binding plus a boolean `allowed`;
missing/stale/deleted/unavailable source state denies. No source CORS is granted.

`POST /knowledge/v1/source-access` uses an upgraded signed owner Supabase JWT.
The body never chooses the acting tenant/object ID. Commands are:

| Action | Body in addition to `action` and `sourceId` |
| --- | --- |
| `status` | None; read-only owner status, does not enroll a source |
| `initialize` | None |
| `confirm_participant` | `expectedAccessRevision`, `subjectObjectId`, owner confirmation `verificationRef` |
| `revoke`, `restore` | `expectedAccessRevision`, `subjectObjectId` |
| `enable`, `disable` | `expectedAccessRevision` |

Mutation commands return only `sourceId`, `accessRevision`, `integrationGeneration`
and `integrationEnabled`. A source not owned by this verified person returns404;
stale revisions409; malformed commands400. The dedicated server key cannot manage
sources, and a user JWT cannot substitute for the integration key. Both paths
accept JSON only, limit request bodies to8 KiB, reject URL queries and avoid
logging upstream errors or returning sensitive diagnostics. Responses use no-store.

`status` returns enrollment, unsupported-transcript and integration state,
revisions, confirmed/denied/direct/project shared object IDs and content-free
delivery counts, receipt time and an allowlisted error code. It does not return
the transcript or title. Missing/unowned sources return404. Disabling remains
possible if an enrolled note's raw transcript has since been removed.

## Owner UI and durable private delivery

The frontend requires exact `VITE_MEETING_KNOWLEDGE_UI_ENABLED=true`. Its entry
point appears only for a note owned by the current MS user. Opening the dialog
reads status and the existing MS directory; enrollment and attendance confirmation
require explicit actions. Contact selection uses canonical directory object IDs,
never diarized speaker labels or email guesses. Every mutation requires the current
access revision;409 reloads status without replaying the mutation. Source links use
`/summary-history?note_id=...` and select only an already loaded, permission-scoped
note. Enabling delivery does not promise that AXKH search is enabled.

CLI-created `20261004042544_meeting_knowledge_transactional_outbox.sql` adds
private RLS-protected stream counters/outbox and service-only status/claim/prepare/
ACK/fail RPCs. Changes enqueue immutable snapshots in the same transaction as the
source revision change. Enabling queues raw and ACL separately; raw/metadata/speaker
edits queue source events, audience edits queue ACL, and delete/disable cancel
pending/leased copies and queue a priority lifecycle event. Empty raw text disables
an active integration; it is never replaced with a summary. No existing source is
automatically enrolled or enabled by the migration.

`MEETING_KNOWLEDGE_DELIVERY_ENABLED=true` starts the in-process poller. Blank settings
are provided in `workflow-server/.env.example`:

| Setting | Use |
| --- | --- |
| `MEETING_KNOWLEDGE_AXKH_URL` | Fixed HTTPS base URL for the private event endpoint |
| `MEETING_KNOWLEDGE_INGEST_KEY` | Dedicated server-only Bearer secret, different from the access-check key |
| `MEETING_KNOWLEDGE_NOTE_BASE_URL` | HTTPS app base URL for permission-scoped note links |
| `MEETING_KNOWLEDGE_TIMEZONE` | Explicit IANA timezone; UTC default, never inferred from meeting prose |

The worker claims at most2 events under a60-second worker/token lease. The claim
RPC and each prepare/HTTP/ACK/failure operation are bounded to5 seconds: the
conservative budget is5 +2 ×20 =45 seconds, leaving room before lease expiry.
Before POST,
`prepare` durably seals the first complete envelope; retries reuse that envelope
even when deployment metadata settings change. Both returned seals and ACKs are
validated against event bindings and immutable source snapshot revisions. Only a
committed AXKH ACK with the matching payload hash completes delivery. Leases expire
after crashes; failures retry with bounded backoff. ACK and cancellation clear both
raw snapshots and prepared envelopes. In-flight copies can still arrive after
cancellation; importer lifecycle fences and live source checks prevent resurrection
or reading them. No uncached ACL snapshot can replace the live read boundary.

The first transport is limited to1 MiB per event. Raw evidence spans cover the
complete unchanged transcript contiguously, at most8000 UTF-16 code units each,
without splitting surrogate pairs. IDs depend only on source ID, content revision
and part index; every span hashes its unchanged substring. These are positional
evidence boundaries, not inferred topics or speaker identities. Larger
events remain pending with `PAYLOAD_TOO_LARGE`; they are never truncated or treated
as complete. Multipart export and semantic spans are later work. HTTP has a5-second
deadline,16 KiB ACK bound, no redirects and no body/token logging. No permanent-error
discard path is implemented. Monitor backlog/error status before opting in sources.

## Local verification and remaining activation gates

Run backend `npm test` and `npm run build`, then the AXKH suite/typecheck. The new
HTTP tests start a real loopback server with synthetic tokens and source records.
The SQL fixtures in `supabase/tests` are local-only: **never run the fixture
bootstrap against a hosted project**. They model legacy tables and roles, exercise
RLS/privileges, real trigger mutations, owner/tenant checks, revision conflicts,
deny history and tombstones, then roll back the test data.

An isolated PostgreSQL WASM engine can verify these scripts without credentials:

```sh
npm install --prefix /tmp/meeting-knowledge-sql-tools --no-audit --no-fund --save-exact @electric-sql/pglite@0.5.8
node scripts/verify-meeting-knowledge-sql.mjs /tmp/meeting-knowledge-sql-tools/node_modules/@electric-sql/pglite/dist/index.js
```

Run these commands from `workflow-server`. The runner applies the migration
twice, executes35 ledger and72 outbox SQL checks, and separately exercises UUID/integer project arrays
and exact multilingual UTF-8 hashing. PGlite verifies real PostgreSQL SQL behavior
in a modeled single-connection environment; it does not prove native Supabase
transport, provider auth, actual deployed schema or concurrent lock behavior.
The cross-repository loopback probe additionally uses the actual AXKH adapter,
HTTP handler, source store and SQL engine while replacing only PostgREST transport.

There is no staging environment. Keep all new flags disabled until an isolated
native Supabase environment validates the migration against the actual note,
project and speaker schemas, migration history and advisors. Check real owner /
participant / revoked / nonparticipant S5 accounts, Microsoft token refresh,
tenant rejection, RLS and service-only RPC exposure. Test multiple concurrent
note/project/attendance writes and timeout/deadlock recovery before deployment.
The earlier identity Edge Function must support the new ID-token header before
its frontend is deployed; that flag also stays off until live SSO is verified.

The private export/outbox/importer is now implemented and locally verified. Next
are policy-gated structured extraction, segmentation/large-packet support and
document/meeting retrieval. A person's S level does not classify a source; the
AXKH private importer keeps classification pending and never inserts meetings
into ordinary shared nodes or existing model/search paths.

## Rollback

Stop the delivery worker and disable consumer flags first; for a source purge,
keep the private importer available long enough to ACK explicit disable/delete
events, then turn it off. Disabling an import flag alone does not erase stored
AXKH evidence. Disable source and AXKH flags, including owner management, and keep the original
document and meeting flows running. Retain the private ledger, tenant association,
audit and tombstones. Dropping that data could permit deleted IDs to re-enroll.
No old table/column/data is removed by this migration. If trigger overhead must
be removed, drop only the three `meeting_knowledge_*_changed` triggers in a
transaction while integration is disabled. Reapplying the migration recreates
them, but revisions missed during that gap are untrusted. A generation bump alone
cannot establish that deletion, ID reuse or ownership changes did not occur.
Keep integration disabled until a future explicit rebuild revalidates the owner,
source lifecycle and current audience of every affected source. Unverifiable
historical grants must not be reused. That rebuild is not implemented here. No
automatic down/destructive script or operating-database rollback is performed.
