// F9 — Autonomous ops agent, pure core (no I/O).
//
// The impure wiring (Supabase queries, Gemini RCA call, email) lives in index.ts;
// everything here is deterministic so it can be unit-tested without booting the
// server or touching prod. See index.ts `fileOpsIncident` for the orchestration.

import { createHash } from 'node:crypto';

export interface OpsSuggestionMeta {
  source: 'f9-ops-agent';
  fingerprint: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  environment: string;
  severity: 'error' | 'warning';
}

export interface OpsErrorFields {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Collapse volatile tokens (uuids, numbers, hex, paths) so every occurrence of the
 * same failure class hashes identically — otherwise a per-job id or timestamp in the
 * message would make each incident look unique and defeat de-duplication.
 */
export function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d[\d,.:_-]*\b/g, '<n>')
    .replace(/[\\/][^\s"']+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 16-hex-char signature of a failure class (title + error name + normalized message). */
export function incidentFingerprint(title: string, errorName: string, errorMessage: string): string {
  const basis = `${normalizeForFingerprint(title)}|${errorName.toLowerCase()}|${normalizeForFingerprint(errorMessage)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

export function opsSeverityToPriority(severity: 'error' | 'warning'): { priority: string; severity: string } {
  return severity === 'warning' ? { priority: 'P3', severity: 'Medium' } : { priority: 'P2', severity: 'High' };
}

/** Find an existing ops ticket for this fingerprint among already-fetched open rows. */
export function matchOpsTicket(
  rows: Array<{ id: string; ai_suggestion: unknown }>,
  fingerprint: string,
): { id: string; meta: OpsSuggestionMeta } | null {
  for (const row of rows) {
    const meta = row.ai_suggestion as OpsSuggestionMeta | null;
    if (meta && meta.source === 'f9-ops-agent' && meta.fingerprint === fingerprint) {
      return { id: row.id, meta };
    }
  }
  return null;
}

/** Return a copy of the meta with the occurrence counter bumped and lastSeen advanced. */
export function bumpOccurrence(meta: OpsSuggestionMeta, nowIso: string): OpsSuggestionMeta {
  return { ...meta, occurrences: (Number(meta.occurrences) || 1) + 1, lastSeen: nowIso };
}

/** Deterministic issue key: OPS-YYYYMMDD-<8 hex>. `randHex8` is injected so tests stay deterministic. */
export function makeOpsIssueKey(now: Date, randHex8: string): string {
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `OPS-${datePart}-${randHex8.toUpperCase()}`;
}

/** Human-readable incident detail fed to the RCA model and stored as the ticket description. */
export function buildOpsIncidentDetail(params: {
  title: string;
  severity: 'error' | 'warning';
  environment: string;
  err: OpsErrorFields;
  contextText: string;
}): string {
  const { title, severity, environment, err, contextText } = params;
  return [
    `제목: ${title}`,
    `심각도: ${severity}`,
    `환경: ${environment}`,
    '',
    `에러: ${err.name}: ${err.message}`,
    err.stack ? `\nStack:\n${err.stack}` : '',
    '',
    `Context:\n${contextText}`,
  ].join('\n');
}

/** Ticket description body (bounded so a huge stack/context cannot blow up the row). */
export function buildOpsTicketDescription(params: {
  title: string;
  err: OpsErrorFields;
  contextText: string;
  maxLength?: number;
}): string {
  const { title, err, contextText, maxLength = 8000 } = params;
  const body = `${title}\n\n에러: ${err.name}: ${err.message}\n\nContext:\n${contextText}${err.stack ? `\n\nStack:\n${err.stack}` : ''}`;
  return body.slice(0, maxLength);
}
