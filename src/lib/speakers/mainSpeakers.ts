import { isAnonymousSpeakerLabel } from '../identifySpeakers';
import { speakerKeyOf, type TranscriptSegment } from '../transcriptSegments';

/**
 * A speaker is "main" when their speaking time is at least this share of the total diarized
 * speaking time (DEC-0024). Main speakers must all be named before the summary refreshes with
 * names; minor speakers never block it. Single constant so it can be tuned with real data.
 */
export const MAIN_SPEAKER_MIN_SHARE = 0.1;

export interface SpeakerShare {
  /** Stable diarization key (speakerKey, or the display name on legacy notes). */
  key: string;
  /** Share of the total speaking time (or text length, see speakerShares), 0..1. */
  share: number;
  /** Distinct display names the key's segments carry, sorted. */
  names: string[];
  /** True when every segment of the key carries a real (non-generic, non-blank) name. */
  named: boolean;
}

function segmentSeconds(segment: TranscriptSegment): number | null {
  const { start, end } = segment;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return end - start;
}

function isRealName(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length > 0 && !isAnonymousSpeakerLabel(trimmed);
}

/**
 * Per-speaker share of the meeting, in first-seen order. Uses speaking time when every segment
 * has a usable start/end; otherwise falls back to text length so a transcript without timings
 * still yields a sensible split.
 */
export function speakerShares(segments: readonly TranscriptSegment[]): SpeakerShare[] {
  const useTime = segments.length > 0 && segments.every((segment) => segmentSeconds(segment) !== null);
  const weightOf = (segment: TranscriptSegment): number =>
    useTime ? (segmentSeconds(segment) ?? 0) : segment.text.trim().length;

  const order: string[] = [];
  const weights = new Map<string, number>();
  const names = new Map<string, Set<string>>();
  const unnamed = new Set<string>();
  let total = 0;
  for (const segment of segments) {
    const key = speakerKeyOf(segment).trim() || segment.speaker.trim();
    if (!weights.has(key)) {
      order.push(key);
      weights.set(key, 0);
      names.set(key, new Set());
    }
    const weight = weightOf(segment);
    weights.set(key, (weights.get(key) ?? 0) + weight);
    total += weight;
    if (isRealName(segment.speaker)) names.get(key)?.add(segment.speaker.trim());
    else unnamed.add(key);
  }

  return order.map((key) => ({
    key,
    share: total > 0 ? (weights.get(key) ?? 0) / total : 0,
    names: [...(names.get(key) ?? [])].sort(),
    named: !unnamed.has(key),
  }));
}

/** Keys of the speakers whose share is at least `minShare`. */
export function mainSpeakerKeys(
  segments: readonly TranscriptSegment[],
  minShare: number = MAIN_SPEAKER_MIN_SHARE
): string[] {
  return speakerShares(segments)
    .filter((speaker) => speaker.share >= minShare)
    .map((speaker) => speaker.key);
}

/**
 * Identity of "who has which name" once every main speaker is named, or null before that.
 * Lists every named speaker (main or minor) as `key=name`, sorted, so any later rename changes
 * it and a rename back to the same names does not. Unnamed minor speakers are left out.
 */
export function namingSignature(
  segments: readonly TranscriptSegment[],
  minShare: number = MAIN_SPEAKER_MIN_SHARE
): string | null {
  const shares = speakerShares(segments);
  const main = shares.filter((speaker) => speaker.share >= minShare);
  if (main.length === 0 || main.some((speaker) => !speaker.named)) return null;
  return shares
    .filter((speaker) => speaker.named)
    .map((speaker) => `${speaker.key}=${speaker.names.join('|')}`)
    .sort()
    .join('\n');
}
