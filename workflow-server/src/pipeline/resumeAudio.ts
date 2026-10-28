// Audio link of a resumed job (S10, DEC-0022, #23). Before a resumed execution pays for a
// fresh AssemblyAI submission it checks that the job's stored audio link still answers.
// When the link expired (a web or Flutter job's client-signed 6 h link outlived by a long
// outage), the server signs a new link for the same recording, but only after a strict
// ownership check; anything that does not match fails with the localized "your recording
// is kept, start again" message (AudioUnavailableError), never an ops incident.
// Imports config, db, the Android upload bucket constant and pipeline errors only.
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { AUDIO_BUCKET } from './androidUpload.js';
import { AudioUnavailableError } from './errors.js';

export const AUDIO_PROBE_TIMEOUT_MS = 15_000;
const AUDIO_PROBE_TRIES = 2;
// Every re-sign I/O (file row, storage owner, signing) is bounded by this.
export const RESIGN_IO_TIMEOUT_MS = 15_000;
// AssemblyAI fetches the link after the submit, so a link this close to its expiry is
// treated as expired and re-signed rather than submitted.
export const RESIGN_EXPIRY_MARGIN_MS = 10 * 60_000;
// Same lifetime the clients and the Android route use.
export const RESIGNED_LINK_SECONDS = 60 * 60 * 6;
const SIGN_PATH_PREFIX = '/storage/v1/object/sign/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENTS = 4;

type Language = 'en' | 'ko';

function projectStorageHost(): string | null {
  try {
    return new URL(env.supabaseUrl).host;
  } catch {
    return null;
  }
}

// True only for an https link on this project's Supabase host. The server never fetches
// any other client-supplied host (SSRF guard).
function isProjectStorageLink(target: URL): boolean {
  const host = projectStorageHost();
  return Boolean(host) && target.protocol === 'https:' && target.host === host && !target.username && !target.password;
}

export interface ProjectSignedUrl {
  bucket: string;
  path: string;
  // From the token's exp claim, or null when the token is not readable. Read without
  // verifying the signature: it only decides whether to probe, never whom to trust.
  expiresAtMs: number | null;
}

function tokenExpiryMs(token: string | null): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Bucket, object path and expiry of a signed storage link on this project, or null for
// anything else. The pathname is already normalized by URL parsing (no dot segments);
// percent-encoded slashes decode into the path and are judged by isSafeRecordingPath.
export function parseProjectSignedUrl(value: string): ProjectSignedUrl | null {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return null;
  }
  if (!isProjectStorageLink(target) || !target.pathname.startsWith(SIGN_PATH_PREFIX)) return null;
  const rest = target.pathname.slice(SIGN_PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  try {
    return {
      bucket: decodeURIComponent(rest.slice(0, slash)),
      path: decodeURIComponent(rest.slice(slash + 1)),
      expiresAtMs: tokenExpiryMs(target.searchParams.get('token')),
    };
  } catch {
    return null;
  }
}

// A storage object name the server may sign. Signing builds an unencoded URL, which the
// HTTP client normalizes, so a dot segment or an encoded one ("%2e%2e") would make the
// signed object differ from the one whose owner was checked (even in another bucket).
// Only plain upload names pass: [A-Za-z0-9._-] segments, none starting with a dot.
export function isSafeRecordingPath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false;
  const segments = path.split('/');
  return segments.length <= MAX_PATH_SEGMENTS && segments.every((segment) => SAFE_SEGMENT_RE.test(segment));
}

export type ProbeResult =
  | { kind: 'skipped' }
  | { kind: 'ok' }
  | { kind: 'unavailable'; status: number | null; problem: string };

// Ranged GET of a project storage link. Other hosts are never fetched ('skipped').
// redirect: 'error' keeps the probe on the storage host even if it answers with a redirect.
export async function probeStorageAudio(downloadUrl: string): Promise<ProbeResult> {
  let target: URL;
  try {
    target = new URL(downloadUrl);
  } catch {
    return { kind: 'skipped' };
  }
  if (!isProjectStorageLink(target)) return { kind: 'skipped' };
  let status: number | null = null;
  let problem = 'not checked';
  for (let attempt = 1; attempt <= AUDIO_PROBE_TRIES; attempt += 1) {
    try {
      const response = await fetch(target, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(AUDIO_PROBE_TIMEOUT_MS) });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { kind: 'ok' };
      status = response.status;
      problem = `HTTP ${response.status}`;
      // A 4xx (expired or invalid signature, deleted object) does not heal on retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      status = null;
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  return { kind: 'unavailable', status, problem };
}

// S10 resume guard without a re-sign: an expired or unreachable project storage link
// fails with a clear, localized message instead of an opaque provider download error.
export async function assertAudioReachable(downloadUrl: string, language: Language): Promise<void> {
  const probe = await probeStorageAudio(downloadUrl);
  if (probe.kind === 'unavailable') throw new AudioUnavailableError(language, probe.problem);
}

// Storage-only client whose every request is bounded (storage-js takes no abort signal).
function boundedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(RESIGN_IO_TIMEOUT_MS);
  const signal = init?.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
const signingClient = createClient(env.supabaseUrl || 'https://placeholder.supabase.co', env.serviceRoleKey || 'missing-service-role-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: boundedFetch },
});

export type ResignRefusal =
  | 'invalid-file-id' | 'not-project-storage-link' | 'link-bucket-mismatch' | 'unsafe-path'
  | 'file-row-missing' | 'file-owner-mismatch' | 'file-bucket-mismatch' | 'file-path-mismatch'
  | 'storage-owner-unknown' | 'storage-owner-mismatch' | 'lookup-failed' | 'sign-failed'
  | 'signed-link-mismatch' | 'fresh-link-unreachable';

export type ResignOutcome = { ok: true; url: string } | { ok: false; reason: ResignRefusal; detail: string };

const refuse = (reason: ResignRefusal, detail: string): ResignOutcome => ({ ok: false, reason, detail });

// The job's file row must name exactly the stored link's object, for the job's user.
async function checkFileRow(fileId: string, userId: string, path: string): Promise<ResignOutcome | null> {
  const { data: row, error: rowError } = await supabase
    .from('file')
    .select('id, user_id, bucket, storage_path')
    .eq('id', fileId)
    .abortSignal(AbortSignal.timeout(RESIGN_IO_TIMEOUT_MS))
    .maybeSingle();
  if (rowError) return refuse('lookup-failed', `file row: ${rowError.message}`);
  const file = row as { user_id?: unknown; bucket?: unknown; storage_path?: unknown } | null;
  if (!file) return refuse('file-row-missing', 'no file row with the stored fileId');
  if (file.user_id !== userId) return refuse('file-owner-mismatch', 'the file row belongs to another user');
  if (file.bucket !== AUDIO_BUCKET) return refuse('file-bucket-mismatch', 'the file row is in another bucket');
  if (file.storage_path !== path) return refuse('file-path-mismatch', 'the file row names another object than the stored link');
  return null;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error));

// Signs a fresh link for the job's recording only when every check holds:
// 1. the stored link is a signed link on this project, in the recordings bucket, to a safe path;
// 2. when the job carries a fileId: its file row exists, belongs to the job's user, is in the
//    recordings bucket and names that same object. File rows are client-writable, so this
//    alone proves nothing, but a mismatch signals tampering and is refused. Without a fileId
//    (a web upload whose file row was not saved, an older Flutter storage ref) the stored
//    link's path is the only locator, and step 3 alone decides;
// 3. storage.objects.owner_id of that object (set by Supabase from the uploader's JWT,
//    not forgeable) equals the job's user. A null owner (legacy upload) is always refused;
// 4. the signed link names the same bucket and object, and it answers.
export async function resignOwnedRecording(input: { userId: string; fileId: string | null; storedUrl: string }): Promise<ResignOutcome> {
  if (input.fileId !== null && !UUID_RE.test(input.fileId)) return refuse('invalid-file-id', 'the stored fileId is not a uuid');
  const stored = parseProjectSignedUrl(input.storedUrl);
  if (!stored) return refuse('not-project-storage-link', 'the stored link is not a signed link on this project');
  if (stored.bucket !== AUDIO_BUCKET) return refuse('link-bucket-mismatch', `the stored link is in bucket ${JSON.stringify(stored.bucket)}`);
  if (!isSafeRecordingPath(stored.path)) return refuse('unsafe-path', 'the stored object path is not a plain upload name');

  if (input.fileId !== null) {
    const fileRefusal = await checkFileRow(input.fileId, input.userId, stored.path);
    if (fileRefusal) return fileRefusal;
  }

  const { data: owner, error: ownerError } = await supabase
    .rpc('storage_object_owner', { p_bucket: AUDIO_BUCKET, p_name: stored.path })
    .abortSignal(AbortSignal.timeout(RESIGN_IO_TIMEOUT_MS));
  if (ownerError) return refuse('lookup-failed', `storage owner: ${ownerError.message}`);
  if (typeof owner !== 'string' || !owner) return refuse('storage-owner-unknown', 'the object has no recorded owner');
  if (owner !== input.userId) return refuse('storage-owner-mismatch', 'the object was uploaded by another user');

  let signedUrl: string;
  try {
    const { data, error } = await signingClient.storage.from(AUDIO_BUCKET).createSignedUrl(stored.path, RESIGNED_LINK_SECONDS);
    if (error || !data?.signedUrl) return refuse('sign-failed', error ? errorText(error) : 'no signed link returned');
    signedUrl = data.signedUrl;
  } catch (error) {
    return refuse('sign-failed', errorText(error));
  }
  const fresh = parseProjectSignedUrl(signedUrl);
  if (!fresh || fresh.bucket !== AUDIO_BUCKET || fresh.path !== stored.path) return refuse('signed-link-mismatch', 'the signed link names another object');
  const probe = await probeStorageAudio(signedUrl);
  if (probe.kind !== 'ok') return refuse('fresh-link-unreachable', probe.kind === 'unavailable' ? probe.problem : 'not probed');
  return { ok: true, url: signedUrl };
}

// The link a resumed execution submits. Re-signs only when needed: the stored link's
// expiry is known and (nearly) past, or its probe answered 4xx. A storage 5xx, 429 or
// network failure is not helped by a new signature and fails as before.
export async function resumableAudioUrl(input: {
  jobId: string;
  userId: string;
  fileId: string | null;
  downloadUrl: string;
  language: Language;
}): Promise<string> {
  const stored = parseProjectSignedUrl(input.downloadUrl);
  let why: string;
  if (stored?.expiresAtMs != null && stored.expiresAtMs <= Date.now() + RESIGN_EXPIRY_MARGIN_MS) {
    why = 'the stored link expired';
  } else {
    const probe = await probeStorageAudio(input.downloadUrl);
    if (probe.kind !== 'unavailable') return input.downloadUrl;
    if (probe.status === null || probe.status >= 500 || probe.status === 429) throw new AudioUnavailableError(input.language, probe.problem);
    why = `the stored link answered ${probe.problem}`;
  }
  const outcome = await resignOwnedRecording({ userId: input.userId, fileId: input.fileId, storedUrl: input.downloadUrl });
  if (!outcome.ok) {
    // The detail can carry decoded client-supplied text (bucket names, storage messages):
    // JSON.stringify keeps it on one quoted line so it cannot forge log entries.
    console.warn(`Workflow job ${input.jobId} does not re-sign its recording (${outcome.reason}): ${JSON.stringify(outcome.detail)}. ${why}; the user restarts the summary.`);
    throw new AudioUnavailableError(input.language, `${why}; re-sign refused (${outcome.reason})`);
  }
  console.log(`Workflow job ${input.jobId} re-signed its recording after ${why}; resuming with the fresh link.`);
  return outcome.url;
}
