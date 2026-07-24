export function formatMeetingDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function formatDurationMeta(seconds: number | null | undefined): string | null {
  const duration = formatMeetingDuration(seconds);
  return duration ? `DURATION: ${duration}` : null;
}

export function getDiarizationDurationSeconds(raw: unknown): number | null {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  const segments = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? findSegmentArray(value as Record<string, unknown>)
      : null;
  if (!segments) return null;

  const maxEnd = segments.reduce((max, segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return max;
    const end = (segment as Record<string, unknown>).end;
    return typeof end === 'number' && Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
  return maxEnd > 0 ? maxEnd : null;
}

export function getNoteDurationSeconds(input: {
  duration_seconds?: number | null;
  diarization?: unknown;
}): number | null {
  if (typeof input.duration_seconds === 'number' && Number.isFinite(input.duration_seconds) && input.duration_seconds > 0) {
    return input.duration_seconds;
  }
  return getDiarizationDurationSeconds(input.diarization);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function findSegmentArray(value: Record<string, unknown>): unknown[] | null {
  for (const key of ['segments', 'transcript', 'diarization', 'utterances', 'items']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}
