// Evidence checks: does a quoted evidence string actually occur in the transcript, and which
// diarized segments does it come from? This is the acceptance metric "evidence_quote exists in
// the transcript ≥ 0.95 (string match)" and also gives each row its evidence_segment_ids.
//
// Matching is exact after a light normalization that cannot change meaning: Unicode NFC, case,
// whitespace runs, and quote characters. An ellipsis ("..." / "…") inside a quote splits it into
// parts that must each occur, in order. A leading "Speaker: " prefix is tolerated because the
// model sees transcript lines in that form.
//
// Segment ids are "s<index>" into the note's diarization array (segments have no stable id of
// their own yet). The handoff prefers diarized segment ids over the backfill's "@N" sentence
// indexes; this is that.

export interface EvidenceSegment {
  speaker: string;
  text: string;
}

export interface EvidenceResult {
  /** null when the evidence is the literal "summary" or empty (nothing to match). */
  match: boolean | null;
  segmentIds: string[];
}

const QUOTE_CHARS = /["'“”‘’「」『』`]/g;

export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(QUOTE_CHARS, '').replace(/\s+/g, ' ').trim();
}

export function isSummaryEvidence(evidence: string | null | undefined): boolean {
  return !evidence || !evidence.trim() || evidence.trim().toLowerCase() === 'summary';
}

export class TranscriptIndex {
  private haystack = '';
  private starts: number[] = [];

  constructor(segments: EvidenceSegment[]) {
    const pieces: string[] = [];
    let offset = 0;
    for (const seg of segments) {
      const line = normalizeForMatch(`${seg.speaker}: ${seg.text}`);
      this.starts.push(offset);
      pieces.push(line);
      offset += line.length + 1; // joined with a single space
    }
    this.haystack = pieces.join(' ');
  }

  /** Segment index containing the given haystack offset. */
  private segmentAt(pos: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  check(evidence: string | null | undefined): EvidenceResult {
    if (isSummaryEvidence(evidence)) return { match: null, segmentIds: [] };
    const parts = (evidence as string)
      .split(/\.{3,}|…/)
      .map(normalizeForMatch)
      .filter((p) => p.length > 0);
    if (parts.length === 0) return { match: null, segmentIds: [] };
    const segIdx = new Set<number>();
    let from = 0;
    for (const raw of parts) {
      let part = raw;
      let at = this.haystack.indexOf(part, from);
      if (at < 0) {
        // Tolerate a "Speaker: " prefix the model copied from the line format.
        const colon = part.indexOf(': ');
        if (colon > 0 && colon < 40) {
          part = part.slice(colon + 2);
          at = part ? this.haystack.indexOf(part, from) : -1;
        }
      }
      if (at < 0) return { match: false, segmentIds: [] };
      const first = this.segmentAt(at);
      const last = this.segmentAt(at + part.length - 1);
      for (let i = first; i <= last; i += 1) segIdx.add(i);
      from = at + part.length;
    }
    return { match: true, segmentIds: [...segIdx].sort((a, b) => a - b).map((i) => `s${i}`) };
  }
}
