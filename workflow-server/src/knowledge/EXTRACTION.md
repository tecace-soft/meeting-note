# Meeting candidate extraction (default off)

`extraction.ts` remains a provider-independent function. The optional
`extraction-worker.ts` now connects it to a durable SQL job, the explicit Gemini
adapter and AXKH processing-policy client. Startup is disabled unless
`MEETING_KNOWLEDGE_EXTRACTION_ENABLED=true`; migration creates no approvals and
enables no sources. Existing personal-memory extraction is a separate flow.
This pipeline has not been evaluated against a live model or real meeting data.

## Trusted caller and policy

`extractMeetingCandidates(source, dependencies, options)` takes a validated
`SourceUpsertEvent`, a caller-created UUID `runId`, a configured model identifier,
and optional budgets/cancellation. `generate(request)` is dependency injection;
there is no default provider. Its response is:

```ts
{
  text: string,
  model: string,                  // must equal the configured identifier
  finishReason: 'stop',            // adapter must map native provider STOP
  usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number }
}
```

The runtime adapter must authenticate its issuer and resolve the approved
model-processing policy for the tenant, source, security classification, region,
retention and provider. Identity verification or permission to read a meeting
alone does not grant permission to send it to a model. `authorizeModel(source)`
must query that authoritative policy; `isCurrent(source)` must check the current
source revision, speaker revision, hash, integration generation, active source
and enabled integration. Browser claims, model output and stale snapshots cannot
supply either decision. Both hooks require exactly `true`; errors/timeouts deny.
The core calls policy before each batch and before returning, and revision fences
before/after each model invocation and before returning. If a policy or revision
fence fails, earlier generated units are removed from the returned result.

The source is canonical-JSON cloned, validated and frozen before asynchronous
work, protecting offsets, hashes and revisions from caller/provider mutation.
Requests and chunk bindings are also immutable. Candidate output never sets
identities, attendance, access grants, classifications, event sequences or source
versions. The runner creates unit IDs from caller `runId`, chunk index and output
index, and creates evidence references from exact authoritative source spans.
The caller must still validate a future `units.upsert` envelope against the
current source context before publishing.

## Random discussions and evidence

Every unchanged UTF-16 text range belongs to a chunk. Defaults are 8,000 code
units and 64 original source span IDs per chunk; boundaries never split surrogate
pairs. A giant raw-text span can therefore be subdivided internally without
changing the shared wire contract. Prompt fragments expose only the relevant
substring and known span IDs. Returned evidence references retain the entire
original source span with its original start/end/hash. This is deliberately
coarser evidence when the source has one giant span; it does not pretend that a
new fine-grained evidence span exists.

The prompt treats transcript contents as untrusted data, includes all topics
rather than a single summary and keeps disagreements, conditions, open questions,
requests and predictions distinct. Strict candidate JSON allows only text,
contract fact/speech types, `reported`/`uncertain`/`hypothesis`, and known evidence
span IDs. No generated unit can become `verified` or `confirmed`; every unit has
lifecycle `candidate`. Fact and speech-act axes remain separate: a requested task stays a task
candidate. Proposals/requests cannot be promoted to decisions or completed
outcomes, questions stay open questions, and hypothesis outcomes/decisions cannot become completed
outcomes or decisions. Semantic correctness is still a model-quality question:
these protections do not prove that a purported decision was actually decided
or that a cause caused an outcome. Human confirmation and evidence-grounded
quality evaluation remain future gates.

## Budgets, partial results and raw fallback

Execution is sequential. Defaults: 256 model chunks, 32 candidates per chunk,
500 units per run, 64,000 output code units, a 30-second model deadline and
3-second policy/revision deadlines. All configuration limits have finite upper
bounds. When the chunk budget is exhausted, one skipped remainder covers all
unprocessed text. No text silently disappears from coverage. Each range reports
`success`, `failed`, `skipped` or `cancelled`, accepted/rejected counts, a safe
error code and `rawFallback`.

Malformed, fenced, structurally invalid, oversized or truncated output rejects
that chunk. Individual invalid candidates (including unknown/out-of-chunk spans
or authority fields) are dropped while valid siblings remain candidates; that
chunk reports failure and raw fallback. Empty successful extraction also keeps
raw fallback. `rawFallback: false` only indicates successful candidate processing; it does
not assert semantic completeness or remove raw-source search. Source storage
remains the source of raw content: coverage contains
no raw transcript and does not create a raw-search or access exception.

Caller cancellation reaches the provider request's `AbortSignal`. After a model
deadline the runner starts no additional model invocation, because an adapter
that ignores abort may still have provider work in flight. Production adapters
must honor the signal and handle network/provider cancellation and billing
according to their provider's semantics. Cancellation or failed authorization
returns no earlier candidate text. Partial results from ordinary failed chunks
may return only after the final policy and revision fences pass.

Run provenance contains configured model, fixed prompt version, caller run ID,
hash of the immutable input event, call count and safely bounded integer token
usage when measured. It does not include provider diagnostics, arbitrary metadata, raw output,
transcript logs or secrets. Each token total becomes `null` if any invoked provider call omits that field
or cannot report usage. Zero represents no provider calls or explicitly measured
zero, never an estimate. A generated candidate is not an approved knowledge classification.

## Durable runtime and policy boundary

A successful source-event ACK atomically queues one job for its exact current
generation/content/speaker/hash. ACK replay never queues a second run. The worker
claims one job, renews its fenced lease, checks current source state between
calls, and saves coverage/provenance plus a `units.upsert` outbox event in one
transaction. Completion releases its raw job snapshot; delivery uses the same
immutable envelope sealing/retry mechanism as source events. Source changes
cancel stale jobs and pending candidate packets. Disable/delete also erase job
snapshots and metadata; AXKH lifecycle events purge the replicated candidates.

After a crash, an expired lease restarts the whole unfinished job. There is no
provider exactly-once guarantee: an interrupted call may already have incurred
cost. Completed runs are deduplicated. Failed policy/current checks keep the job
pending with backoff and publish no units. Ordinary failed chunks may complete
with explicit raw-fallback coverage; they are not automatically retried as
individual chunks. The worker defaults to 16 chunks, configurable up to 64;
text beyond that budget is retained as an explicit skipped remainder. These are
bounded initial operating budgets, not claims of complete semantic extraction.

The metadata-only AXKH policy endpoint uses a third dedicated server key. It
requires an explicit, unexpired operator-approved S1–S5 processing policy for
the exact source revision, provider and model. Google `global` region and
`provider-default` retention are explicit policy terms, not a promise of local
processing or zero retention. Missing/revoked/stale policy denies. A person's
clearance or access to a meeting cannot approve model processing. New content
or speaker revision requires an updated policy; automated project policy
inheritance and an authenticated classification UI remain future work.

The adapter uses the existing Gemini transport with cancellation, a bounded
response, separate system instructions, and only native STOP completion. It
never silently switches model/provider. Provenance identifies the configured
model; optional native model-version metadata is not an authenticated version
attestation. Provider errors never enter coverage or application logs.

## Remaining product integration

Human correction/review, approved project policy inheritance, failed-chunk
resume, search/indexing, document/entity links and role views remain separate
work. Consumers must apply live access and approved AXKH read classification
before retrieval, model context, citation or graph traversal. Processing-policy
approval does not grant read access or publish candidates to the shared graph.
The curated-document ingest policy is unchanged. Native SSO/PostgREST,
multi-connection concurrency, provider quality/cost and real-meeting evaluation
remain activation gates; see `EXTRACTION-ROLLOUT.md`.

Synthetic verification:

```sh
cd workflow-server
node --import tsx src/knowledge/extraction.test.ts
npm run build
```
