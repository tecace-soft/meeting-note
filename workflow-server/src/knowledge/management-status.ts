import { isCanonicalMicrosoftId } from './access-contract.js';

export interface MeetingManagementAcknowledgement {
  sourceId: string;
  accessRevision: number;
  integrationGeneration: number;
  integrationEnabled: boolean;
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
  if (Object.keys(status).length !== keys.length || Object.keys(status).some(key => !keys.includes(key))
    || status.sourceId !== sourceId || typeof status.enrolled !== 'boolean' || typeof status.unsupportedTranscript !== 'boolean'
    || typeof status.integrationEnabled !== 'boolean'
    || (status.enrolled ? !revision(status.accessRevision) || !revision(status.integrationGeneration)
      : status.accessRevision !== null || status.integrationGeneration !== null || status.integrationEnabled)) return false;
  if (![status.participants, status.denies, status.directShares, status.projectShares].every(ids => Array.isArray(ids)
    && ids.length <= 10_000 && ids.every(isCanonicalMicrosoftId) && new Set(ids).size === ids.length)) return false;
  const delivery = status.delivery;
  return !!delivery && typeof delivery === 'object' && !Array.isArray(delivery) && Object.keys(delivery).length === 3
    && Object.keys(delivery).every(key => ['pending', 'lastDeliveredAt', 'lastErrorCode'].includes(key))
    && Number.isSafeInteger(delivery.pending) && delivery.pending >= 0
    && (delivery.lastDeliveredAt === null || typeof delivery.lastDeliveredAt === 'string' && Number.isFinite(Date.parse(delivery.lastDeliveredAt)))
    && (delivery.lastErrorCode === null || DELIVERY_ERROR_CODES.includes(delivery.lastErrorCode as typeof DELIVERY_ERROR_CODES[number]));
}
