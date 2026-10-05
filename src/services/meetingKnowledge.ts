import { getSupabaseAccessTokenForRequest } from '../config/supabaseConfig';
// Pure DTO validation; a frontend-local copy (see meetingKnowledgeStatus.ts) so the
// web bundle does not import across the project boundary into the server source tree.
import { isMeetingProcessingStatus, type MeetingProcessingStatus } from './meetingKnowledgeStatus';

const API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');
export const meetingKnowledgeUiEnabled = import.meta.env.VITE_MEETING_KNOWLEDGE_UI_ENABLED === 'true';
const SAFE_DELIVERY_ERROR_CODES = new Set(['DELIVERY_FAILED', 'IMPORT_REJECTED', 'INVALID_SNAPSHOT', 'PAYLOAD_TOO_LARGE', 'CONFIG_UNAVAILABLE']);
export const isMicrosoftObjectId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export interface MeetingKnowledgeStatus {
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
  processing?: MeetingProcessingStatus;
  workers?: { delivery: boolean; extraction: boolean };
}
export type MeetingKnowledgeAction = 'initialize' | 'confirm_participant' | 'revoke' | 'restore' | 'enable' | 'disable' | 'resync';
export interface MeetingKnowledgeCommand {
  sourceId: string;
  action: MeetingKnowledgeAction;
  expectedAccessRevision?: number;
  subjectObjectId?: string;
  verificationRef?: string;
  contentRevision?: number; speakerRevision?: number; integrationGeneration?: number; sourceHash?: string;
}
export class MeetingKnowledgeApiError extends Error {
  constructor(public readonly status: number) { super('Meeting knowledge request failed'); }
}
async function request(body: { sourceId: string; action: string; [key: string]: unknown }, signal?: AbortSignal): Promise<unknown> {
  if (!meetingKnowledgeUiEnabled || !API_URL) throw new MeetingKnowledgeApiError(503);
  const token = await getSupabaseAccessTokenForRequest();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!token) throw new MeetingKnowledgeApiError(401);
  const response = await fetch(`${API_URL}/knowledge/v1/source-access`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
  });
  if (!response.ok) throw new MeetingKnowledgeApiError(response.status);
  return response.json().catch(() => { throw new MeetingKnowledgeApiError(502); });
}
function parseStatus(value: unknown, sourceId: string): MeetingKnowledgeStatus {
  if (!value || typeof value !== 'object') throw new MeetingKnowledgeApiError(502);
  const status = value as MeetingKnowledgeStatus;
  const ids = [status.participants, status.denies, status.directShares, status.projectShares];
  const validRevision = (revision: unknown) => revision === null || (Number.isSafeInteger(revision) && (revision as number) > 0);
  if (status.sourceId !== sourceId || typeof status.enrolled !== 'boolean' || typeof status.unsupportedTranscript !== 'boolean'
    || typeof status.integrationEnabled !== 'boolean' || !validRevision(status.accessRevision) || !validRevision(status.integrationGeneration)
    || ids.some(list => !Array.isArray(list) || list.some(id => typeof id !== 'string' || !isMicrosoftObjectId(id)))
    || !status.delivery || !Number.isSafeInteger(status.delivery.pending) || status.delivery.pending < 0
    || (status.delivery.lastDeliveredAt !== null && (typeof status.delivery.lastDeliveredAt !== 'string' || !Number.isFinite(Date.parse(status.delivery.lastDeliveredAt))))
    || (status.delivery.lastErrorCode !== null && !SAFE_DELIVERY_ERROR_CODES.has(status.delivery.lastErrorCode))
    || (status.enrolled && (status.accessRevision === null || status.integrationGeneration === null))
    || (status.processing !== undefined && (!isMeetingProcessingStatus(status.processing, sourceId)
      || status.processing.canResync && (!status.enrolled || !status.integrationEnabled)
      || status.processing.binding !== null && (!status.enrolled || status.processing.binding.accessRevision !== status.accessRevision
        || status.processing.binding.integrationGeneration !== status.integrationGeneration)))
    || (status.workers !== undefined && (!status.workers || Object.keys(status.workers).sort().join(',') !== 'delivery,extraction'
      || typeof status.workers.delivery !== 'boolean' || typeof status.workers.extraction !== 'boolean'))) {
    throw new MeetingKnowledgeApiError(502);
  }
  return status;
}
export async function getMeetingKnowledgeStatus(sourceId: string, signal?: AbortSignal): Promise<MeetingKnowledgeStatus> {
  return parseStatus(await request({ action: 'status', sourceId }, signal), sourceId);
}
export async function mutateMeetingKnowledge(command: MeetingKnowledgeCommand, signal?: AbortSignal): Promise<void> {
  await request({ ...command }, signal);
}
