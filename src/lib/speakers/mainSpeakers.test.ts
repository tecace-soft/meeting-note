import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '../transcriptSegments';
import { MAIN_SPEAKER_MIN_SHARE, mainSpeakerKeys, namingSignature, speakerShares } from './mainSpeakers';

const seg = (speaker: string, key: string, start: number, end: number, text = 'words'): TranscriptSegment => ({
  speaker,
  speakerKey: key,
  text,
  start,
  end,
});

// A: 60s, B: 35s, C: 5s (C is a minor speaker at 5%).
const meeting = (a = 'Speaker A', b = 'Speaker B', c = 'Speaker C'): TranscriptSegment[] => [
  seg(a, 'Speaker A', 0, 30),
  seg(b, 'Speaker B', 30, 65),
  seg(c, 'Speaker C', 65, 70),
  seg(a, 'Speaker A', 70, 100),
];

describe('speakerShares', () => {
  it('sums speaking time per speaker key and keeps first-seen order', () => {
    const shares = speakerShares(meeting());
    expect(shares.map((s) => [s.key, Math.round(s.share * 100)])).toEqual([
      ['Speaker A', 60],
      ['Speaker B', 35],
      ['Speaker C', 5],
    ]);
  });

  it('falls back to text length when any segment lacks a usable time', () => {
    const shares = speakerShares([
      { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'x'.repeat(90) },
      { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'y'.repeat(10), start: 0, end: 5 },
    ]);
    expect(shares.map((s) => [s.key, s.share])).toEqual([
      ['Speaker A', 0.9],
      ['Speaker B', 0.1],
    ]);
  });

  it('marks a speaker named only when none of its segments still carry a generic label', () => {
    const segments = meeting('Andrew', 'Hansoo');
    segments[3] = { ...segments[3], speaker: 'Speaker A' };
    const byKey = Object.fromEntries(speakerShares(segments).map((s) => [s.key, s.named]));
    expect(byKey).toEqual({ 'Speaker A': false, 'Speaker B': true, 'Speaker C': false });
  });

  it('uses the display name as the key for legacy segments without speakerKey', () => {
    const shares = speakerShares([
      { speaker: 'Pat', text: 'a', start: 0, end: 1 },
      { speaker: 'Speaker 2', text: 'b', start: 1, end: 2 },
    ]);
    expect(shares.map((s) => [s.key, s.named])).toEqual([
      ['Pat', true],
      ['Speaker 2', false],
    ]);
  });

  it('returns [] for an empty transcript', () => {
    expect(speakerShares([])).toEqual([]);
  });
});

describe('mainSpeakerKeys', () => {
  it('keeps speakers at or above the threshold', () => {
    expect(MAIN_SPEAKER_MIN_SHARE).toBe(0.1);
    expect(mainSpeakerKeys(meeting())).toEqual(['Speaker A', 'Speaker B']);
    // Exactly 10% counts as main.
    expect(mainSpeakerKeys([seg('Speaker A', 'Speaker A', 0, 9), seg('Speaker B', 'Speaker B', 9, 10)])).toEqual([
      'Speaker A',
      'Speaker B',
    ]);
  });
});

describe('namingSignature', () => {
  it('is null until every main speaker has a real name', () => {
    expect(namingSignature(meeting())).toBeNull();
    expect(namingSignature(meeting('Andrew'))).toBeNull();
    expect(namingSignature([])).toBeNull();
  });

  it('does not wait for minor speakers', () => {
    expect(namingSignature(meeting('Andrew', 'Hansoo'))).toBe('Speaker A=Andrew\nSpeaker B=Hansoo');
  });

  it('changes when any speaker name changes, including a minor speaker', () => {
    const base = namingSignature(meeting('Andrew', 'Hansoo'));
    expect(namingSignature(meeting('Andrew', 'Mina'))).not.toBe(base);
    expect(namingSignature(meeting('Andrew', 'Hansoo', 'Jin'))).not.toBe(base);
    expect(namingSignature(meeting('Andrew', 'Hansoo'))).toBe(base);
  });

  it('treats blank labels as unnamed', () => {
    expect(namingSignature(meeting('  ', 'Hansoo'))).toBeNull();
  });
});
