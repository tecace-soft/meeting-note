# Gemini meeting generator (explicit opt-in)

`createGeminiMeetingGenerator({ apiKey, model, fetch? })` adapts the existing
`callGemini` transport to the extraction core. Import and factory creation make
no request. This file reads no environment variables. Startup must supply the
existing server-only `GEMINI_API_KEY` and one explicitly approved plain
`gemini-*` model ID; it must not infer model authorization from the presence of
a key or ordinary summary access. There is no automatic fallback, retry, file
upload, browser credential or new public endpoint in this adapter.

The caller's authoritative model-processing policy and current-source checks
remain mandatory. The extraction core invokes those checks before each batch
and before publication. Configuring this factory alone does not enable worker
processing, authorize a source, approve classification or make candidates
searchable. Deployment/activation and live model-quality evaluation remain
separate work.

## Transport and instructions

Requests use the fixed Google HTTPS `generateContent` host. The key appears only
in `x-goog-api-key`; URL redirects are rejected. Trusted extraction instructions
are sent as `systemInstruction.parts`, separately from the transcript JSON in
`contents[0].parts`. Transcript instructions remain untrusted even though the
provider supports this separation. JSON response mode and temperature zero do
not prove semantic correctness: candidate schema, evidence and lifecycle checks
remain in the extraction core.

The request's `AbortSignal` reaches fetch and response reading. Cancellation
also settles the adapter when an injected transport ignores abort, without
starting another request. A late transport response is discarded and its body
cancelled. Production native fetch aborts its request; a custom
transport must honor the signal to stop its underlying work. The core owns its
model deadline and starts no additional batch after a deadline.

Responses are streamed under a fixed 256 KiB bound before JSON parsing. An
oversized Content-Length is rejected before reading; actual bytes remain bounded
when that header is missing or inaccurate. UTF-8 is decoded incrementally, so a
multi-byte code point split between chunks is valid, and invalid UTF-8 fails.
Body reading is cancelled on overflow or abort. Factory configuration and input
budgets are validated without printing request contents or credentials.

Only native `STOP` maps to core `stop`. `MAX_TOKENS`, `SAFETY`, blocked prompts,
unknown reasons or missing finish reasons remain `incomplete`, including empty
blocked output. The core rejects these chunks as truncated rather than accepting
apparently valid but incomplete JSON. Transport, HTTP, malformed provider JSON,
usage-validation and other failures expose only `MODEL_FAILED`. Raw provider
messages, network causes, transcript text and API keys are not returned/logged
by this adapter.

Native `promptTokenCount`, `candidatesTokenCount` and `totalTokenCount` become
input/output/total token measurements only when individually present and safe
nonnegative integers. Missing fields are omitted, so the core reports unknown
aggregates as `null`. Other usage fields, including thoughts/cache counts, are
not fabricated into these totals. Token counts do not constitute verified cost
or billing measurements.

Provenance records the configured model identifier. `callGemini` can return
optional provider `modelVersion`, but this adapter does not put it into the
strict core response or claim that a configured alias is an authenticated exact
provider version. The core's fixed prompt version, caller run ID, input hash and
measured/unknown usage remain the extraction provenance.

## Existing pipeline compatibility

The shared Gemini transport gains additive optional signal, injected fetch,
response byte bound, redirect behavior, separated system instructions and
incomplete-output handling. Existing callers supply none of these and retain
ordinary response-text reading, request defaults, prompt/empty-output failures,
HTTP retry classification and existing generation settings. Optional native
finish/model-version metadata is available without requiring any caller changes.
The meeting adapter alone opts into bounded/cancellable strict transport and
incomplete-output inspection.

Synthetic verification uses injected Responses/streams, with no live provider
request:

```sh
cd workflow-server
node --import tsx src/knowledge/extraction-provider.test.ts
npm run build
```

Coverage includes fixed endpoint/instruction separation, no factory requests,
finish reasons, partial/missing usage, invalid measurements, provider failures,
no retries/fallbacks, byte/header bounds, streaming UTF-8, pre/fetch/body abort,
legacy transport defaults/errors and core truncation/unknown-usage integration.
