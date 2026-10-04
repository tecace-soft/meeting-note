import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isCanonicalMicrosoftId, isMeetingLiveAccessRequest } from './access-contract.js';
import { verifyMeetingNoteIdentity, type MeetingIdentityVerification } from './identity.js';
import { checkMeetingSourceAccess, type MeetingSourceAccessRecord } from './source-access.js';
import type { MeetingManagementAcknowledgement, MeetingOwnerStatus } from './management-status.js';
import { fetchMeetingEvidence, type MeetingEvidenceStore } from './evidence.js';
import { isMeetingEvidenceFetchRequest } from './evidence-contract.js';

export interface MeetingManagementCommand {
  action: 'status' | 'initialize' | 'confirm_participant' | 'revoke' | 'restore' | 'enable' | 'disable';
  sourceId: string;
  expectedAccessRevision?: number;
  subjectObjectId?: string;
  verificationRef?: string;
}
type Identity = { tenantId: string; objectId: string };
type MeetingManagementMutation = Omit<MeetingManagementCommand, 'action' | 'expectedAccessRevision'> & {
  action: Exclude<MeetingManagementCommand['action'], 'initialize' | 'status'>;
  expectedAccessRevision: number;
};
export interface MeetingKnowledgeHttpStore {
  loadCurrentEvidence?: MeetingEvidenceStore['loadCurrentEvidence'];
  initialize(identity: Identity, sourceId: string): Promise<MeetingSourceAccessRecord>;
  mutate(identity: Identity, command: MeetingManagementMutation): Promise<MeetingSourceAccessRecord | MeetingManagementAcknowledgement>;
  getOwnedStatus(identity: Identity, sourceId: string): Promise<MeetingOwnerStatus>;
  loadCurrentSource(tenantId: string, sourceId: string): Promise<MeetingSourceAccessRecord | null>;
}
export interface MeetingKnowledgeHttpEnvironment {
  MEETING_KNOWLEDGE_ACCESS_ENABLED?: string;
  MEETING_KNOWLEDGE_ACCESS_KEY?: string;
  MEETING_KNOWLEDGE_TENANT_ID?: string;
  MEETING_KNOWLEDGE_MANAGEMENT_ENABLED?: string;
  SUPABASE_JWT_SECRET?: string;
  ALLOWED_MS_TENANT_IDS?: string;
  APP_FRONTEND_ORIGIN?: string;
}
const ACCESS_PATH = '/knowledge/v1/access-check';
const EVIDENCE_PATH = '/knowledge/v1/evidence-fetch';
const MANAGEMENT_PATH = '/knowledge/v1/source-access';
const MAX_BODY_BYTES = 8_192;
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}
function authorizedService(req: IncomingMessage, key: string): boolean {
  const token = bearer(req);
  if (token.length === 0 || token.length > 1_024) return false;
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(hash(token), hash(key));
}
function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && new TextEncoder().encode(value).length >= 32
    && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(value);
}
function identityOptions(environment: MeetingKnowledgeHttpEnvironment): MeetingIdentityVerification {
  const allowedTenantIds = (environment.ALLOWED_MS_TENANT_IDS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const signingSecret = environment.SUPABASE_JWT_SECRET ?? '';
  if (new TextEncoder().encode(signingSecret).length < 32 || allowedTenantIds.length === 0
    || allowedTenantIds.length > 32 || !allowedTenantIds.every(isCanonicalMicrosoftId)) {
    throw new HttpError(503, 'KNOWLEDGE_CONFIG_UNAVAILABLE');
  }
  return { allowedTenantIds, signingSecret };
}
function managementCommand(value: unknown): MeetingManagementCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_MANAGEMENT_REQUEST');
  const command = value as MeetingManagementCommand;
  if (Object.keys(command).some(key => !['action', 'sourceId', 'expectedAccessRevision', 'subjectObjectId', 'verificationRef'].includes(key))
    || typeof command.sourceId !== 'string' || command.sourceId.length < 1 || command.sourceId.length > 256
    || !['status', 'initialize', 'confirm_participant', 'revoke', 'restore', 'enable', 'disable'].includes(command.action)) {
    throw new HttpError(400, 'INVALID_MANAGEMENT_REQUEST');
  }
  if (command.action === 'initialize' || command.action === 'status') {
    if (Object.keys(command).length !== 2) throw new HttpError(400, 'INVALID_MANAGEMENT_REQUEST');
    return command;
  }
  if (!Number.isSafeInteger(command.expectedAccessRevision) || command.expectedAccessRevision! < 1) throw new HttpError(400, 'INVALID_MANAGEMENT_REQUEST');
  const subjectAction = ['confirm_participant', 'revoke', 'restore'].includes(command.action);
  if (subjectAction !== (command.subjectObjectId !== undefined)
    || (subjectAction && !isCanonicalMicrosoftId(command.subjectObjectId))
    || (command.action === 'confirm_participant'
      ? typeof command.verificationRef !== 'string' || command.verificationRef.length < 1 || command.verificationRef.length > 512
      : command.verificationRef !== undefined)) throw new HttpError(400, 'INVALID_MANAGEMENT_REQUEST');
  return command;
}
function readJson(req: IncomingMessage): Promise<unknown> {
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json' || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    throw new HttpError(415, 'JSON_REQUIRED');
  }
  const declaredLength = req.headers['content-length'];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) throw new HttpError(413, 'REQUEST_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: HttpError, value?: unknown) => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new HttpError(413, 'REQUEST_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new HttpError(400, 'INVALID_JSON')); }
    };
    const onError = () => finish(new HttpError(400, 'INVALID_REQUEST'));
    const timer = setTimeout(() => finish(new HttpError(408, 'REQUEST_TIMEOUT')), 3_000);
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onError);
  });
}

/** Separate server and owner credentials; evidence requires current version-bound audience access. */
export function createMeetingKnowledgeHttpHandler(store: MeetingKnowledgeHttpStore, environment: MeetingKnowledgeHttpEnvironment) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (![ACCESS_PATH, EVIDENCE_PATH, MANAGEMENT_PATH].includes(url.pathname)) return false;
    try {
      const evidence = url.pathname === EVIDENCE_PATH;
      const access = url.pathname === ACCESS_PATH || evidence;
      if ((access ? environment.MEETING_KNOWLEDGE_ACCESS_ENABLED : environment.MEETING_KNOWLEDGE_MANAGEMENT_ENABLED) !== 'true') throw new HttpError(404, 'NOT_FOUND');
      if (url.search) throw new HttpError(evidence ? 404 : 400, evidence ? 'NOT_FOUND' : 'INVALID_REQUEST');
      if (!access && req.headers.origin) {
        const allowedOrigin = environment.APP_FRONTEND_ORIGIN;
        if (!allowedOrigin || allowedOrigin === '*' || req.headers.origin !== allowedOrigin) throw new HttpError(403, 'ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
      }
      if (!access && req.method === 'OPTIONS') {
        if (!req.headers.origin) throw new HttpError(403, 'ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
        respond(res, 200, { ok: true }); return true;
      }
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (access) {
        const key = environment.MEETING_KNOWLEDGE_ACCESS_KEY;
        const tenantId = environment.MEETING_KNOWLEDGE_TENANT_ID;
        if (!validSecret(key) || !isCanonicalMicrosoftId(tenantId)) throw new HttpError(503, 'KNOWLEDGE_CONFIG_UNAVAILABLE');
        if (!authorizedService(req, key)) throw new HttpError(401, 'UNAUTHORIZED');
        if (evidence) {
          // Content requests fail uniformly without echoing identifiers or stored metadata.
          let body: unknown;
          try { body = await readJson(req); } catch { throw new HttpError(404, 'NOT_FOUND'); }
          if (!isMeetingEvidenceFetchRequest(body) || body.tenantId !== tenantId || !store.loadCurrentEvidence) throw new HttpError(404, 'NOT_FOUND');
          const result = await fetchMeetingEvidence(body, {
            loadCurrentSource: store.loadCurrentSource.bind(store), loadCurrentEvidence: store.loadCurrentEvidence.bind(store),
          });
          if (!result) throw new HttpError(404, 'NOT_FOUND');
          respond(res, 200, result);
          return true;
        }
        const body = await readJson(req);
        if (!isMeetingLiveAccessRequest(body)) throw new HttpError(400, 'INVALID_ACCESS_REQUEST');
        if (body.tenantId !== tenantId) throw new HttpError(403, 'TENANT_DENIED');
        respond(res, 200, await checkMeetingSourceAccess(body, store.loadCurrentSource.bind(store)));
      } else {
        const identity = await verifyMeetingNoteIdentity(bearer(req), identityOptions(environment));
        if (!identity.authenticated) throw new HttpError(401, 'UNVERIFIED_IDENTITY');
        const command = managementCommand(await readJson(req));
        if (command.action === 'status') {
          respond(res, 200, await store.getOwnedStatus(identity.identity, command.sourceId));
          return true;
        }
        const source = command.action === 'initialize'
          ? await store.initialize(identity.identity, command.sourceId)
          : await store.mutate(identity.identity, command as MeetingManagementMutation);
        respond(res, 200, { sourceId: source.sourceId, accessRevision: source.accessRevision,
          integrationGeneration: source.integrationGeneration, integrationEnabled: source.integrationEnabled });
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const status = code === 'SOURCE_NOT_MANAGEABLE' ? 404 : code === 'REVISION_CONFLICT' ? 409 : code === 'INVALID_MUTATION' ? 400 : 503;
      // Never pass SQL errors, identifiers, JWTs or upstream diagnostic text to the host logger.
      respond(res, error instanceof HttpError ? error.status : status,
        { error: error instanceof HttpError ? error.code : status === 503 ? 'KNOWLEDGE_UNAVAILABLE' : code });
      req.resume();
    }
    return true;
  };
}
