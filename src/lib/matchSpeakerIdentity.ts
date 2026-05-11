/**
 * Normalize an MS display name or transcript speaker label for identity matching:
 * strips parenthetical segments (e.g. alternate-script names), removes non–Latin letters
 * (symbols, digits, CJK), lowercases, collapses whitespace.
 */
export function normalizeNameForIdentityMatch(raw: string): string {
  let s = raw.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[^a-zA-Z]+/g, ' ');
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function scoreSpeakerMatch(msNormalized: string, speakerNormalized: string): number {
  if (!msNormalized || !speakerNormalized) return -1;
  if (msNormalized === speakerNormalized) return 1000 + speakerNormalized.length;
  const msTok = msNormalized.split(' ').filter(Boolean);
  const spTok = speakerNormalized.split(' ').filter(Boolean);
  // Speaker is a token-prefix of the MS name (first name only, or full name subset).
  if (spTok.length <= msTok.length && spTok.every((t, i) => t === msTok[i])) {
    return 500 + spTok.length * 50 + speakerNormalized.length;
  }
  return -1;
}

export interface SpeakerRowLike {
  name: string;
}

/**
 * Latin-script name for a new speaker row: drops parenthetical segments and non‑Latin scripts.
 * Example: "Gene Kim (김진)" → "Gene Kim"
 */
export function deriveSelfSpeakerNameFromMsDisplayName(raw: string): string | null {
  let s = raw.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[^a-zA-Z]+/g, ' ');
  s = s.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s
    .split(' ')
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');
}

/** Pick the best speaker row whose normalized name matches the MS account display name. */
export function findBestSpeakerRowForMsAccount<T extends SpeakerRowLike>(
  rows: T[],
  msDisplayName: string
): T | null {
  const msNorm = normalizeNameForIdentityMatch(msDisplayName);
  let best: T | null = null;
  let bestScore = -1;
  for (const row of rows) {
    const spNorm = normalizeNameForIdentityMatch(row.name);
    const sc = scoreSpeakerMatch(msNorm, spNorm);
    if (sc > bestScore) {
      bestScore = sc;
      best = row;
    } else if (sc === bestScore && sc >= 0 && best && row.name.length > best.name.length) {
      best = row;
    }
  }
  return bestScore >= 0 ? best : null;
}
