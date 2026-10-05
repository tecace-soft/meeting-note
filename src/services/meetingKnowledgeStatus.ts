// Frontend-local copy of the pure meeting-knowledge status DTO and its validator.
// This intentionally duplicates a small, pure (no transport, no secrets) validator
// from workflow-server/src/knowledge so the web bundle does not import across the
// project boundary into the server source tree. Keep it in sync with
// management-status.ts / access-contract.ts if the wire shape changes.

export interface MeetingSourceBinding {
  tenantId: string;
  sourceId: string;
  contentRevision: number;
  speakerRevision: number;
  accessRevision: number;
  sourceHash: string;
  integrationGeneration: number;
}

export const isCanonicalMicrosoftId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function isMeetingSourceBinding(value: unknown): value is MeetingSourceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return isCanonicalMicrosoftId(source.tenantId)
    && typeof source.sourceId === 'string' && source.sourceId.length > 0 && source.sourceId.length <= 256
    && typeof source.sourceHash === 'string' && /^[0-9a-f]{64}$/.test(source.sourceHash)
    && ['contentRevision', 'speakerRevision', 'accessRevision', 'integrationGeneration'].every(key =>
      typeof source[key] === 'number' && Number.isSafeInteger(source[key]) && (source[key] as number) >= 1);
}

export interface MeetingProcessingStatus {
  binding: MeetingSourceBinding | null;
  sourceBytes: number; encodedSourceBytes: number; sourceLimitBytes: number;
  sizing: 'ready' | 'oversized' | 'unsupported';
  deliveryState: 'idle' | 'queued' | 'running' | 'retrying' | 'delivered' | 'blocked';
  extractionState: 'not-started' | 'queued' | 'running' | 'completed' | 'partial' | 'blocked' | 'cancelled';
  extractionErrorCode: string | null;
  successfulChunks: number; failedChunks: number; skippedChunks: number;
  canResync: boolean;
}

export function isMeetingProcessingStatus(value: unknown, sourceId: string): value is MeetingProcessingStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as MeetingProcessingStatus;
  return Object.keys(p).sort().join(',') === 'binding,canResync,deliveryState,encodedSourceBytes,extractionErrorCode,extractionState,failedChunks,sizing,skippedChunks,sourceBytes,sourceLimitBytes,successfulChunks'
    && (p.binding === null || isMeetingSourceBinding(p.binding) && p.binding.sourceId === sourceId && Object.keys(p.binding).length === 7)
    && [p.sourceBytes, p.encodedSourceBytes, p.successfulChunks, p.failedChunks, p.skippedChunks].every(n => Number.isSafeInteger(n) && n >= 0)
    && p.sourceLimitBytes === 900_000 && ['ready', 'oversized', 'unsupported'].includes(p.sizing)
    && ['idle', 'queued', 'running', 'retrying', 'delivered', 'blocked'].includes(p.deliveryState)
    && ['not-started', 'queued', 'running', 'completed', 'partial', 'blocked', 'cancelled'].includes(p.extractionState)
    && (p.extractionErrorCode === null || ['POLICY_DENIED', 'POLICY_UNAVAILABLE', 'SOURCE_STALE', 'CURRENT_UNAVAILABLE', 'CANCELLED', 'EXTRACTION_FAILED', 'INVALID_SNAPSHOT', 'PAYLOAD_TOO_LARGE'].includes(p.extractionErrorCode))
    && typeof p.canResync === 'boolean' && (!p.canResync || p.binding !== null && p.sizing === 'ready');
}
