import type { TranscriptSegment } from './transcriptSegments';

const ENCRYPTION_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_ALGORITHM = 'PBKDF2';
const KEY_ITERATIONS = 310000;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const USER_SECRET_BYTES = 32;
const USER_SECRET_STORAGE_PREFIX = 'meeting-note:encryption-secret:';
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export type EncryptedNotePayload = {
  version: number;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  kdf: typeof KEY_ALGORITHM;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type NoteSensitivePayload = {
  summary?: string | null;
  summary_edit?: string | null;
  summary_translations?: Record<string, string> | null;
  transcription?: string | null;
  diarization?: TranscriptSegment[] | unknown;
};

export type EncryptableNote = NoteSensitivePayload & {
  encrypted_payload?: unknown;
  encryption_version?: number | null;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function deriveKey(userId: string, salt: Uint8Array): Promise<CryptoKey> {
  const userSecret = getOrCreateUserEncryptionSecret(userId);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(base64ToBytes(userSecret)),
    KEY_ALGORITHM,
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: KEY_ALGORITHM,
      salt: toArrayBuffer(salt),
      iterations: KEY_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

function getOrCreateUserEncryptionSecret(userId: string): string {
  const storageKey = `${USER_SECRET_STORAGE_PREFIX}${userId}`;
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = bytesToBase64(randomBytes(USER_SECRET_BYTES));
  window.localStorage.setItem(storageKey, created);
  return created;
}

function isEncryptedPayload(value: unknown): value is EncryptedNotePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<EncryptedNotePayload>;
  return (
    payload.version === ENCRYPTION_VERSION &&
    payload.algorithm === ENCRYPTION_ALGORITHM &&
    payload.kdf === KEY_ALGORITHM &&
    typeof payload.salt === 'string' &&
    typeof payload.iv === 'string' &&
    typeof payload.ciphertext === 'string'
  );
}

export async function encryptNoteSensitivePayload(
  userId: string,
  payload: NoteSensitivePayload
): Promise<EncryptedNotePayload> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(userId, salt);
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: ENCRYPTION_ALGORITHM, iv: toArrayBuffer(iv) }, key, plaintext);
  return {
    version: ENCRYPTION_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    kdf: KEY_ALGORITHM,
    iterations: KEY_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptNoteSensitivePayload(
  userId: string,
  encryptedPayload: unknown
): Promise<NoteSensitivePayload | null> {
  if (!isEncryptedPayload(encryptedPayload)) return null;
  const salt = base64ToBytes(encryptedPayload.salt);
  const iv = base64ToBytes(encryptedPayload.iv);
  const ciphertext = base64ToBytes(encryptedPayload.ciphertext);
  const key = await deriveKey(userId, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext)
  );
  return JSON.parse(TEXT_DECODER.decode(plaintext)) as NoteSensitivePayload;
}

export async function decryptNoteForDisplay<T extends EncryptableNote>(userId: string, note: T): Promise<T> {
  if (!note.encrypted_payload || !note.encryption_version) return note;
  const decrypted = await decryptNoteSensitivePayload(userId, note.encrypted_payload);
  if (!decrypted) return note;
  return {
    ...note,
    summary: decrypted.summary ?? '',
    summary_edit: decrypted.summary_edit ?? null,
    summary_translations: decrypted.summary_translations ?? null,
    transcription: decrypted.transcription ?? '',
    diarization: decrypted.diarization ?? null,
  };
}

export async function decryptNotesForDisplay<T extends EncryptableNote>(userId: string, notes: T[]): Promise<T[]> {
  return Promise.all(notes.map((note) => decryptNoteForDisplay(userId, note)));
}

export function buildEncryptedNoteColumns(encryptedPayload: EncryptedNotePayload): {
  encrypted_payload: EncryptedNotePayload;
  encryption_version: number;
  encryption_algorithm: string;
  encrypted_at: string;
} {
  return {
    encrypted_payload: encryptedPayload,
    encryption_version: ENCRYPTION_VERSION,
    encryption_algorithm: ENCRYPTION_ALGORITHM,
    encrypted_at: new Date().toISOString(),
  };
}
