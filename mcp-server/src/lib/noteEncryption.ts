import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { getScopedAuthContext, type NoteRow } from './supabase.js';

interface EncryptedNotePayload {
  version: number;
  algorithm: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

interface SensitiveNotePayload {
  summary?: string | null;
  summary_edit?: string | null;
  summary_translations?: unknown;
  transcription?: string | null;
  diarization?: unknown;
}

function isEncryptedNotePayload(value: unknown): value is EncryptedNotePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.version === 1 &&
    payload.algorithm === 'AES-GCM' &&
    payload.kdf === 'PBKDF2' &&
    typeof payload.iterations === 'number' &&
    typeof payload.salt === 'string' &&
    typeof payload.iv === 'string' &&
    typeof payload.ciphertext === 'string'
  );
}

function decryptPayload(secret: string, payload: EncryptedNotePayload): SensitiveNotePayload {
  const key = pbkdf2Sync(Buffer.from(secret, 'base64'), Buffer.from(payload.salt, 'base64'), payload.iterations, 32, 'sha256');
  const encrypted = Buffer.from(payload.ciphertext, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as SensitiveNotePayload;
}

export function decryptNoteForMcp<T extends NoteRow>(note: T): T {
  if (!isEncryptedNotePayload(note.encrypted_payload)) return note;

  const userId = note.user_id?.trim();
  if (!userId) {
    return { ...note, decryption_error: 'Encrypted note is missing an owner user id.' };
  }

  const authContext = getScopedAuthContext();
  const secret = authContext.userId === userId ? authContext.noteEncryptionSecret : undefined;
  if (!secret) {
    return { ...note, decryption_error: 'No note decryption secret was provided by this MCP token.' };
  }

  try {
    const payload = decryptPayload(secret, note.encrypted_payload);
    return {
      ...note,
      summary: payload.summary ?? note.summary,
      summary_edit: payload.summary_edit ?? note.summary_edit,
      summary_translations: payload.summary_translations ?? note.summary_translations,
      transcription: payload.transcription ?? note.transcription,
      diarization: payload.diarization ?? note.diarization,
      decryption_error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...note, decryption_error: `Failed to decrypt note payload: ${message}` };
  }
}

export function decryptNotesForMcp<T extends NoteRow>(notes: T[]): T[] {
  return notes.map((note) => decryptNoteForMcp(note));
}
