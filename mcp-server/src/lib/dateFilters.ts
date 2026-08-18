import { getEnv } from './env.js';

export interface DateFilterInput {
  date?: string;
  startDate?: string;
  endDate?: string;
  // IANA zone for interpreting bare YYYY-MM-DD bounds. Defaults to MCP_DEFAULT_TIME_ZONE
  // (America/Los_Angeles) so "2026-08-18" means that calendar day in the user's zone, not UTC.
  timeZone?: string;
}

export interface ResolvedDateFilter {
  startIso?: string;
  endIso?: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Strict ISO-8601 date-time: date + T + HH:MM(:SS)(.fff)? + optional Z or ±HH:MM offset.
// Anything else (e.g. "2026", "May", "08/18/2026") is rejected rather than lenient-parsed.
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

function resolveTimeZone(input?: string): string {
  return input?.trim() || getEnv().mcpDefaultTimeZone;
}

// Minutes to ADD to UTC to get local wall-clock time in `timeZone` at the given instant.
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

// The UTC instant of local midnight (00:00 in `timeZone`) for a YYYY-MM-DD string.
function zonedDayStartUtc(dateOnly: string, timeZone: string): Date | null {
  const trimmed = dateOnly.trim();
  if (!DATE_ONLY_RE.test(trimmed)) return null;
  const [y, mo, d] = trimmed.split('-').map(Number);
  const guessMs = Date.UTC(y, mo - 1, d, 0, 0, 0);
  if (Number.isNaN(guessMs)) return null;
  // Reject impossible calendar dates that pass the regex (e.g. 2026-13-40). Date.UTC
  // silently normalizes overflow, so a round-trip mismatch means the input was invalid.
  const guess = new Date(guessMs);
  if (guess.getUTCFullYear() !== y || guess.getUTCMonth() !== mo - 1 || guess.getUTCDate() !== d) return null;
  // Correct the "wall clock as if UTC" guess by the zone's offset at that instant. Exact
  // for fixed-offset zones (KST = +9, no DST); DST zones are correct except the rare
  // midnight-of-a-transition edge, which is irrelevant to the KST user base.
  const start = new Date(guessMs - zoneOffsetMinutes(new Date(guessMs), timeZone) * 60000);
  return Number.isNaN(start.getTime()) ? null : start;
}

// The YYYY-MM-DD calendar day after `dateOnly`.
function nextDay(dateOnly: string): string {
  const [y, mo, d] = dateOnly.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// Parse one bound. Date-only → the zone-day boundary (start = local midnight; end = the
// NEXT local midnight, so the range is a half-open [day, nextDay)). Full ISO date-time →
// the exact instant (its own offset/Z respected; a naked date-time is UTC per JS). Junk → null.
function parseBound(value: string, opts: { endOfDay: boolean; timeZone: string }): Date | null {
  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    return opts.endOfDay ? zonedDayStartUtc(nextDay(trimmed), opts.timeZone) : zonedDayStartUtc(trimmed, opts.timeZone);
  }
  if (DATE_TIME_RE.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function resolveDateFilter(input: DateFilterInput): ResolvedDateFilter {
  const timeZone = resolveTimeZone(input.timeZone);
  if (input.date?.trim()) {
    const start = zonedDayStartUtc(input.date, timeZone);
    if (!start) throw new Error('date must use YYYY-MM-DD format.');
    const end = zonedDayStartUtc(nextDay(input.date), timeZone);
    return { startIso: start.toISOString(), endIso: end?.toISOString() };
  }

  const start = input.startDate?.trim() ? parseBound(input.startDate, { endOfDay: false, timeZone }) : null;
  const end = input.endDate?.trim() ? parseBound(input.endDate, { endOfDay: true, timeZone }) : null;
  if (input.startDate?.trim() && !start) throw new Error('startDate must be YYYY-MM-DD or an ISO 8601 date-time.');
  if (input.endDate?.trim() && !end) throw new Error('endDate must be YYYY-MM-DD or an ISO 8601 date-time.');
  if (start && end && start.getTime() >= end.getTime()) {
    throw new Error('startDate must be before endDate.');
  }

  return {
    startIso: start?.toISOString(),
    endIso: end?.toISOString(),
  };
}

/**
 * Filter notes by meeting date. Uses `meeting_at` when present, and falls back to
 * `created_at` for notes whose `meeting_at` is null (mirrors the app's calendar query).
 * Emits a single PostgREST `.or(...)` combining both branches; if no bounds are set the
 * query is returned unchanged (so optional-date tools keep their "no date arg = no filter").
 */
export function applyMeetingDateFilter<T extends { or: (filters: string) => T }>(
  query: T,
  filter: ResolvedDateFilter,
): T {
  const meetingBounds: string[] = [];
  const createdBounds: string[] = [];
  if (filter.startIso) {
    meetingBounds.push(`meeting_at.gte.${filter.startIso}`);
    createdBounds.push(`created_at.gte.${filter.startIso}`);
  }
  if (filter.endIso) {
    meetingBounds.push(`meeting_at.lt.${filter.endIso}`);
    createdBounds.push(`created_at.lt.${filter.endIso}`);
  }
  if (meetingBounds.length === 0) return query;

  const meetingClause = meetingBounds.length > 1 ? `and(${meetingBounds.join(',')})` : meetingBounds[0];
  const createdClause = `and(meeting_at.is.null,${createdBounds.join(',')})`;
  return query.or(`${meetingClause},${createdClause}`);
}

export function describeDateFilter(input: DateFilterInput, resolved: ResolvedDateFilter): Record<string, string | null> {
  return {
    date: input.date ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    startIso: resolved.startIso ?? null,
    endIso: resolved.endIso ?? null,
  };
}
