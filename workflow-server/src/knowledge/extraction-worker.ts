import { randomUUID } from 'node:crypto';
import { isCanonicalMicrosoftId } from './access-contract.js';
import { canonicalJson } from './contract.js';
import { extractMeetingCandidates, type ExtractionDependencies } from './extraction.js';
import { isMeetingExtractionClaim, validateMeetingExtractionResult, MeetingExtractionStoreError, type MeetingExtractionFailureCode, type MeetingExtractionStore } from './extraction-store.js';

export interface MeetingExtractionEnvironment {
  MEETING_KNOWLEDGE_EXTRACTION_ENABLED?: string;
  MEETING_KNOWLEDGE_TENANT_ID?: string;
  MEETING_KNOWLEDGE_EXTRACTION_MODEL?: string;
  MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS?: string;
}
export interface MeetingExtractionWorkerDependencies {
  generate: ExtractionDependencies['generate'];
  authorizeModel: ExtractionDependencies['authorizeModel'];
  workerId?: string;
  /** Shorter injected deadline for offline tests; production defaults to30 seconds. */
  modelTimeoutMs?: number;
}
export class MeetingExtractionWorkerError extends Error { constructor() { super('CONFIG_UNAVAILABLE'); } }
export function createMeetingExtractionWorker(store: MeetingExtractionStore, env: MeetingExtractionEnvironment,
  dependencies: MeetingExtractionWorkerDependencies) {
  const enabled = env.MEETING_KNOWLEDGE_EXTRACTION_ENABLED === 'true';
  const workerId = dependencies.workerId ?? randomUUID();
  const tenantId = env.MEETING_KNOWLEDGE_TENANT_ID;
  const model = env.MEETING_KNOWLEDGE_EXTRACTION_MODEL;
  const maxChunks = Number(env.MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS ?? '16');
  const modelTimeoutMs = dependencies.modelTimeoutMs ?? 30_000;
  if (enabled && (!isCanonicalMicrosoftId(workerId) || !isCanonicalMicrosoftId(tenantId)
    || !model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)
    || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 64
    || !Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > 30_000)) throw new MeetingExtractionWorkerError();
  let running = false; let stopped = false; let active: AbortController | undefined;
  return {
    enabled,
    stop() { stopped = true; active?.abort(); },
    async processOnce(): Promise<{ claimed: number; completed: number; failed: number; lostLease: number }> {
      const stats = { claimed: 0, completed: 0, failed: 0, lostLease: 0 };
      if (!enabled || running || stopped) return stats;
      running = true;
      let interval: ReturnType<typeof setInterval> | undefined;
      let heartbeat: Promise<void> | undefined;
      try {
        const claims = await store.claim(tenantId!, workerId); stats.claimed = claims.length;
        if (claims.length > 1) throw new Error('EXTRACTION_STORE_UNAVAILABLE');
        if (!claims.length || stopped) return stats;
        const claim = JSON.parse(canonicalJson(claims[0])) as typeof claims[0];
        let fault: MeetingExtractionFailureCode | undefined;
        let providerAttemptStarted = false;
        const controller = new AbortController(); active = controller;
        try {
          if (!isMeetingExtractionClaim(claim, tenantId!)) { fault = 'INVALID_SNAPSHOT'; throw new Error(); }
          const current = async () => {
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              const allowed = await Promise.race([store.current(claim, workerId), new Promise<never>((_, reject) => {
                deadline = setTimeout(() => reject(new Error('CURRENT_UNAVAILABLE')), 5_000);
              })]);
              if (allowed !== true) { fault ??= 'SOURCE_STALE'; controller.abort(); }
              return allowed === true;
            } catch { fault ??= 'CURRENT_UNAVAILABLE'; controller.abort(); throw new Error('CURRENT_UNAVAILABLE'); }
            finally { if (deadline) clearTimeout(deadline); }
          };
          interval = setInterval(() => {
            if (heartbeat || controller.signal.aborted) return;
            heartbeat = current().then(() => undefined, () => undefined).finally(() => { heartbeat = undefined; });
          }, 15_000);
          interval.unref();
          const result = await extractMeetingCandidates(claim.sourceEvent, {
            async generate(request) {
              if (!providerAttemptStarted) {
                if (!store.beginProviderAttempt || !await store.beginProviderAttempt(claim, workerId)) {
                  fault ??= 'EXTRACTION_FAILED'; controller.abort(); throw new Error('EXTRACTION_FAILED');
                }
                providerAttemptStarted = true;
              }
              return dependencies.generate(request);
            },
            async authorizeModel(source) {
              try {
                const allowed = await dependencies.authorizeModel(source);
                if (allowed !== true) fault ??= 'POLICY_DENIED';
                return allowed === true;
              } catch { fault ??= 'POLICY_UNAVAILABLE'; throw new Error('POLICY_UNAVAILABLE'); }
            },
            isCurrent: current,
          }, { runId: claim.jobId, model: model!, maxChunks, modelTimeoutMs, signal: controller.signal });
          if (interval) { clearInterval(interval); interval = undefined; }
          await heartbeat;
          // A policy/current timeout may be observed by the core before an RPC
          // settles. Never publish its emptied result or clear earlier safe units.
          const terminal = result.coverage.find(state => ['POLICY_DENIED', 'POLICY_UNAVAILABLE',
            'SOURCE_STALE', 'CURRENT_UNAVAILABLE', 'CANCELLED'].includes(state.errorCode ?? ''))?.errorCode;
          if (terminal) fault ??= terminal as MeetingExtractionFailureCode;
          if (stopped || controller.signal.aborted || fault) throw new Error();
          validateMeetingExtractionResult(claim, result);
          // Renew/check once more immediately before the SQL completion fence.
          if (!await current() || controller.signal.aborted || stopped) throw new Error();
          if (await store.complete(claim, workerId, result)) stats.completed++; else stats.lostLease++;
        } catch (error) {
          if (stopped) return stats; // Lease expiry handles process shutdown safely.
          if (error instanceof MeetingExtractionStoreError && error.code === 'PAYLOAD_TOO_LARGE') fault = 'PAYLOAD_TOO_LARGE';
          const code = fault ?? (controller.signal.aborted ? 'CANCELLED' : 'EXTRACTION_FAILED');
          try { if (await store.fail(claim, workerId, code)) stats.failed++; else stats.lostLease++; }
          catch { stats.failed++; } // No discard fallback; the durable lease expires.
        }
        return stats;
      } finally {
        if (interval) clearInterval(interval);
        active = undefined; running = false;
      }
    },
  };
}

/** Polling never owns retry state; the SQL queue delays failures between leases. */
export function startMeetingExtractionWorker(store: MeetingExtractionStore, env: MeetingExtractionEnvironment,
  dependencies: MeetingExtractionWorkerDependencies) {
  const worker = createMeetingExtractionWorker(store, env, dependencies);
  let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || !worker.enabled) return;
    try { await worker.processOnce(); } catch { /* RPC failure preserves pending jobs. */ }
    if (!stopped) { timer = setTimeout(() => { void tick(); }, 5_000); timer.unref(); }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); worker.stop(); };
}
