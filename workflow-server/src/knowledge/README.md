# Meeting knowledge transfer — contract v1 (PR0)

This directory defines a server-only transport contract and internal access-policy foundations. No meeting export, search, model or HTTP/MCP integration uses these modules yet. The matching AXKH directory is `lib/meeting-knowledge/`. `contract.ts`, `event.schema.json`, `synthetic-fixtures.json`, and `access-contract.ts` must remain byte-identical across the two repositories. Changes to either copy require validation on both sides before enabling an integration.

All committed examples are synthetic. Real meeting transcripts and evaluation answers belong in a restricted evaluation environment, never in the public Meeting Note repository.

## Input and integrity

`validateMeetingKnowledgeEvent(input, sourceContext?)` checks strict JSON Schema Draft 7 and integrity rules. On failure it returns an error code, without including transcript content or raw AJV errors. A successful result means **valid transport data**, not an authenticated source or authorized user.

Every event includes `schemaVersion`, `eventId`, per-source `eventSeq`, `integrationGeneration`, `sourceApp`, `sourceId`, `tenantId`, `payloadHash`, `eventType`, and `payload`. UUIDs identify Microsoft tenants and object IDs; display names, email aliases, speaker labels, or diarization guesses cannot substitute for them.

| Event | Independent state | Required consumer behavior in PR1/PR2 |
| --- | --- | --- |
| `source.upsert` | Content/speaker revision, unchanged plaintext, full span coverage | Store privately; wait for authenticated access and AXKH classification policy before search or model use |
| `access.changed` | Access revision, verified participant/share grants, explicit denies, optional classification policy reference | Update access without waiting for extraction; authenticate grant verification server-side |
| `units.upsert` | Content/speaker revision, source hash, extractor run, evidence-bound knowledge candidates | Accept only for the current source revision; never change access |
| `source.deleted` | Lifecycle revision | Block retrieval, remove replicated derivatives under retention policy, retain only a minimal replay tombstone |
| `integration.disabled` | Lifecycle revision | Block the source and its derivatives; only an explicitly authorized new integration generation may reactivate it |

`eventSeq` supports deduplication, tracing and gap detection. It is **not** a single last-write-wins clock for partial events. Content and access revisions advance independently. An access update arriving before a matching content event must not cause the content to be discarded, and late content must not restore older access. Tombstones and integration generations take precedence over old replay. This contract does not implement that durable consumer state machine.

Hashes use lowercase SHA-256. `sourceHash` hashes the UTF-8 bytes of unchanged `plaintext`. Span `textHash` hashes `plaintext.slice(start, end)` encoded as UTF-8. Offsets count JavaScript UTF-16 code units, use `[start, end)`, cover the full plaintext contiguously, and cannot split a surrogate pair. Do not trim, normalize Unicode, translate, or reformat the text before hashing. Payload hashes use `hashPayload(payload)`, which serializes JSON with recursively sorted object keys while preserving array order; this is the local v1 convention, not a claim of RFC 8785 compatibility. Payload hashes detect alteration; they are not signatures.

For `units.upsert`, pass the validated current `source.upsert` event as `sourceContext`. The validator checks source/tenant/generation/revisions/hash and the exact referenced span. Without context, it can check reference structure and internal agreement but **cannot establish that a span exists**. An importer must load the authoritative stored revision and supply it. Import authentication, request byte limits, tenant/integration binding and transaction isolation remain required outside this module.

The v1 source event is a complete revision in one message. Multipart/chunked delivery is not implemented; oversized sources need an explicit versioned extension and atomic manifest validation, rather than treating a partial source as complete.

## Access is an intersection

The eventual retrieval gate is:

1. AXKH verifies the logged-in Microsoft `tenantId + objectId`, active account, read role and current S1–S5 clearance using its existing authority.
2. AXKH resolves an administrator-approved **content classification** policy; a source cannot assign the user's clearance. A missing policy leaves content pending, without search/model use. Do not default to S2 or copy a participant's S level onto a meeting.
3. The user has a currently valid confirmed participant, direct-share or eligible project-share grant. Explicit revocation overrides participant history and other grants. Project sharing follows the original note/project ownership rules, not company-wide membership. Note management ownership alone does not grant AXKH retrieval.
4. The source server confirms current access and content/access revisions before using evidence in model context, and again before returning a meeting-derived answer. An unavailable source check fails closed for that meeting.

The `verification` field is a statement from the producer; its literal authority and an ID-shaped value do not prove verification. PR1 must authenticate the producer and validate the original grant source. A name appearing in a transcript cannot create a grant. ACL snapshots alone cannot guarantee immediate revocation.

Titles, snippets, embeddings, links, graph paths, role views, caches and generated insights inherit their source restrictions. Linking a meeting to a public document cannot widen access. Meeting content must not flow automatically into AXKH's shared-node, partner publication, digest or general context paths.

## Small ontology, free conversation

Keep the full plaintext available under the source policy. Units add source-bound evidence and optional speech act, fact type, epistemic state and lifecycle; they do not replace the source. Unclassified conversation and unknown entities remain usable through permitted raw retrieval. A request is not acceptance, a proposal is not a confirmed decision, a forecast is not an observed outcome, and a reported explanation is not proven causality. Schema-valid labels do not establish factual truth.

PPT, HTML, Word and other curated documents keep their existing AXKH ingest path. Later stages adapt document sections and meeting spans to common evidence references, resolve shared entity/topic candidates, then add shallow ABOUT/SUPPORTED_BY and evidence-backed correction/condition links. Business-person entities stay separate from Microsoft authentication identities. This increment does not replace the existing ontology or introduce a graph database.

## Next increments and release gate

The first PR1 increment adds these internal boundaries:

- Meeting Note `knowledge/identity.ts` verifies a signed upgraded Supabase JWT and resolves only server-verified tenant/object identities. The optional Edge Function ID-token upgrade and browser token pairing are documented in `supabase/functions/supabase-token/README.md` in that repository. The flag remains disabled until real SSO testing.
- Meeting Note `knowledge/source-access.ts` evaluates confirmed attendance, direct shares and owner-matched project shares, with explicit deny precedence and no ownership-only retrieval. Its loader must supply trusted current persistent state; it is not a database implementation or an authenticated endpoint.
- AXKH `meeting-knowledge/access.ts` combines its existing active/read-role/S-clearance principal policy with approved content classification, the meeting audience and a live exact source/identity/version check. It denies service principals and unavailable source checks, with a3-second deadline. Its current-principal helper must use the existing session/HR resolver.
- Shared `access-contract.ts` pins the tenant/object/source/content/speaker/access/hash/generation binding. A source denial exposes no stored metadata. These types do not authenticate a server or grant access by themselves.

This is **PR1 identity/policy foundation**, not the complete PR1 release gate. Still required: verified note-owner tenant mapping, confirmed-participant/deny persistence and owner-authorized writes, atomic current-source/revision lookup, scoped service-to-service authentication and HTTP/MCP adapters, RLS integration and real multi-user SSO verification. Do not wire a browser-provided resource, legacy unscoped MCP query or producer-provided approval flag into these modules as trusted state.

- **PR1:** verified tenant/object identities, original participant/share/revocation access, AXKH principal/classification intersection, scoped access-check.
- **PR2:** transactional outbox, durable importer/index jobs, content/access/lifecycle revisions, replay, ordering, restart and delete tests against a development database.
- **PR3/PR4:** extraction with full coverage, uncertainty/correction handling, document+meeting retrieval, source-gated answers with citations.
- **PR5/PR6:** basic role views, actual multi-user SSO tests, independent holdout evaluation, limited beta.

Contract tests use synthetic data and need no hosted secrets. They do not replace the earlier retrieval-question evaluation, native model quality evaluation or real RLS/SSO/worker tests. The PR0 contract is not ready for production ingestion until the subsequent authorization and durable storage gates pass.

Hosted Render/Supabase/Vercel variables need not be reissued. This execution environment still needs authenticated CLI access and appropriate development endpoints for live integration tests. Never print or commit pulled environment files.

Run `npm test` and `npm run build` in Meeting Note's `workflow-server/`; run `npm test` and `npx tsc --noEmit` in AXKH. Run each repository's lint gate before merging. Compare the mirrored files across both checkouts before changing the contract version.
