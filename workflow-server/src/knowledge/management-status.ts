import { isCanonicalMicrosoftId, isMeetingSourceBinding, type MeetingSourceBinding } from './access-contract.js';

export interface MeetingManagementAcknowledgement {
  sourceId: string;
  accessRevision: number;
  integrationGeneration: number;
  integrationEnabled: boolean;
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
    && p.sourceLimitBytes === 900_000 && ['ready','oversized','unsupported'].includes(p.sizing)
    && ['idle','queued','running','retrying','delivered','blocked'].includes(p.deliveryState)
    && ['not-started','queued','running','completed','partial','blocked','cancelled'].includes(p.extractionState)
    && (p.extractionErrorCode === null || ['POLICY_DENIED','POLICY_UNAVAILABLE','SOURCE_STALE','CURRENT_UNAVAILABLE','CANCELLED','EXTRACTION_FAILED','INVALID_SNAPSHOT','PAYLOAD_TOO_LARGE'].includes(p.extractionErrorCode))
    && typeof p.canResync === 'boolean' && (!p.canResync || p.binding !== null && p.sizing === 'ready');
}
export interface MeetingOwnerStatus {
  sourceId: string;
  enrolled: boolean;
  unsupportedTranscript: boolean;
  integrationEnabled: boolean;
  accessRevision: number | null;
  integrationGeneration: number | null;
  participants: string[];
  denies: string[];
  directShares: string[];
  projectShares: string[];
  processing?: MeetingProcessingStatus;
  workers?: { delivery: boolean; extraction: boolean };
  delivery: { pending: number; lastDeliveredAt: string | null; lastErrorCode: string | null };
}
export const DELIVERY_ERROR_CODES = ['DELIVERY_FAILED', 'IMPORT_REJECTED', 'INVALID_SNAPSHOT', 'PAYLOAD_TOO_LARGE', 'CONFIG_UNAVAILABLE'] as const;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
export function isManagementAcknowledgement(value: unknown, sourceId: string): value is MeetingManagementAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as MeetingManagementAcknowledgement;
  return Object.keys(result).length === 4 && result.sourceId === sourceId
    && revision(result.accessRevision) && revision(result.integrationGeneration) && typeof result.integrationEnabled === 'boolean';
}
export function isMeetingOwnerStatus(value: unknown, sourceId: string): value is MeetingOwnerStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as MeetingOwnerStatus;
  const keys = ['sourceId', 'enrolled', 'unsupportedTranscript', 'integrationEnabled', 'accessRevision', 'integrationGeneration', 'participants', 'denies', 'directShares', 'projectShares', 'delivery'];
  if (Object.keys(status).length !== keys.length + (status.processing === undefined ? 0 : 1) + (status.workers === undefined ? 0 : 1) || Object.keys(status).some(key => !keys.includes(key) && !['processing','workers'].includes(key))
    || status.sourceId !== sourceId || typeof status.enrolled !== 'boolean' || typeof status.unsupportedTranscript !== 'boolean'
    || typeof status.integrationEnabled !== 'boolean'
    || (status.enrolled ? !revision(status.accessRevision) || !revision(status.integrationGeneration)
      : status.accessRevision !== null || status.integrationGeneration !== null || status.integrationEnabled)) return false;
  if (![status.participants, status.denies, status.directShares, status.projectShares].every(ids => Array.isArray(ids)
    && ids.length <= 10_000 && ids.every(isCanonicalMicrosoftId) && new Set(ids).size === ids.length)) return false;
  if (status.processing !== undefined && (!isMeetingProcessingStatus(status.processing, sourceId)
    || status.processing.canResync && (!status.integrationEnabled || !status.enrolled)
    || status.processing.binding !== null && (!status.enrolled || status.processing.binding.accessRevision !== status.accessRevision
      || status.processing.binding.integrationGeneration !== status.integrationGeneration))) return false;
  if (status.workers !== undefined && (!status.workers || Object.keys(status.workers).sort().join(',') !== 'delivery,extraction'
    || typeof status.workers.delivery !== 'boolean' || typeof status.workers.extraction !== 'boolean')) return false;
  const delivery = status.delivery;
  return !!delivery && typeof delivery === 'object' && !Array.isArray(delivery) && Object.keys(delivery).length === 3
    && Object.keys(delivery).every(key => ['pending', 'lastDeliveredAt', 'lastErrorCode'].includes(key))
    && Number.isSafeInteger(delivery.pending) && delivery.pending >= 0
    && (delivery.lastDeliveredAt === null || typeof delivery.lastDeliveredAt === 'string' && Number.isFinite(Date.parse(delivery.lastDeliveredAt)))
    && (delivery.lastErrorCode === null || DELIVERY_ERROR_CODES.includes(delivery.lastErrorCode as typeof DELIVERY_ERROR_CODES[number]));
}
