export interface DateFilterInput {
  date?: string;
  startDate?: string;
  endDate?: string;
}

export interface ResolvedDateFilter {
  startIso?: string;
  endIso?: string;
}

function parseDateOnly(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateOrDateTime(value: string, endOfDay: boolean): Date | null {
  const dateOnly = parseDateOnly(value);
  if (dateOnly) {
    if (endOfDay) dateOnly.setUTCDate(dateOnly.getUTCDate() + 1);
    return dateOnly;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveDateFilter(input: DateFilterInput): ResolvedDateFilter {
  if (input.date?.trim()) {
    const start = parseDateOnly(input.date);
    if (!start) throw new Error('date must use YYYY-MM-DD format.');
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }

  const start = input.startDate?.trim() ? parseDateOrDateTime(input.startDate, false) : null;
  const end = input.endDate?.trim() ? parseDateOrDateTime(input.endDate, true) : null;
  if (input.startDate && !start) throw new Error('startDate must be YYYY-MM-DD or an ISO date-time.');
  if (input.endDate && !end) throw new Error('endDate must be YYYY-MM-DD or an ISO date-time.');
  if (start && end && start.getTime() >= end.getTime()) {
    throw new Error('startDate must be before endDate.');
  }

  return {
    startIso: start?.toISOString(),
    endIso: end?.toISOString(),
  };
}

export function applyCreatedAtFilter<T extends { gte: (column: string, value: string) => T; lt: (column: string, value: string) => T }>(
  query: T,
  filter: ResolvedDateFilter,
): T {
  let next = query;
  if (filter.startIso) next = next.gte('created_at', filter.startIso);
  if (filter.endIso) next = next.lt('created_at', filter.endIso);
  return next;
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
