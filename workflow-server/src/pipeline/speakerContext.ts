import type { TranscriptSegment } from '../parsers.js';

// F5.0: build a speaker-context hint from a NAMED diarization — the distinct real
// speaker names present (generic "Speaker A/B" / "Unknown Speaker" labels are dropped).
// Lets insight extraction resolve action owners and participants to real names.
export function buildSpeakerContextFromSegments(segments: TranscriptSegment[]): string | null {
  const names = Array.from(
    new Set(
      segments
        .map((segment) => segment.speaker)
        .filter((name) => name && name !== 'Unknown Speaker' && !/^speaker\s/i.test(name)),
    ),
  );
  if (names.length === 0) return null;
  return `Meeting participants (the transcript's speaker labels are these real names): ${names.join(', ')}.`;
}
