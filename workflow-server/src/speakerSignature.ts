// Signature-based speaker identification (pure, deterministic, NO I/O) — see
// SPEAKER_SIGNATURE_DESIGN.md. Each roster member gets a TEXT signature built from their PAST
// labeled utterances; an anonymous label is matched to the nearest signature by TF-IDF cosine.
// The ceiling probe (eval:speaker-signature) measured this at ~77.5% warm vs ~37% for the LLM
// identifier, because a signature captures each person's ACTUAL language (distinctive projects /
// phrasing) instead of an overlapping role-summary profile.
//
// This module is I/O-free: the CALLER loads the labeled utterances (the edge function from the
// DB, the backtest from its cases) and passes them in, so the same code is measured and shipped.
// The caller runs the LLM identifier for the fallback labels this returns, then merges + gates.

import { sameName } from './speakerAnchors.js';

export interface LabeledUtterance { noteId: string; name: string; text: string }
export interface PersonCorpus { key: string; display: string; docs: Array<{ noteId: string; tokens: string[] }> }
export type Corpora = Map<string, PersonCorpus>;

export interface RosterEntry { speakerId: string; name: string }
export interface SigSuggestion {
  label: string;
  name: string;
  speakerId: string | null;
  confidence: number;
  isSelf: boolean;
  top1: number;
  margin: number;
}
export interface DecideOptions {
  tScore?: number; // min top1 cosine to promote a signature pick
  tMargin?: number; // min (top1 - top2) cosine margin to promote
  minSigTokens?: number; // min tokens of history for a usable signature
}
const DEFAULTS: Required<DecideOptions> = { tScore: 0.08, tMargin: 0.02, minSigTokens: 8 };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
// Content tokens: Korean runs (>=2 chars) + Latin words (>=2). Drops 1-char noise + digits.
export const tokenize = (s: string): string[] => (s.toLowerCase().match(/[가-힣]{2,}|[a-z]{2,}/g) ?? []);
// Canonical person key: strip a parenthetical script variant, lowercase, collapse spaces.
export const canonName = (s: string): string =>
  s.replace(/\s*[(（【\[].*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Group labeled utterances into per-person corpora, keyed by canonical name. */
export function buildCorpora(utterances: LabeledUtterance[]): Corpora {
  const corpora: Corpora = new Map();
  for (const u of utterances) {
    const display = (u.name ?? '').trim();
    const key = canonName(display);
    if (!key) continue;
    const tokens = tokenize(u.text ?? '');
    if (tokens.length === 0) continue;
    const person = corpora.get(key) ?? { key, display, docs: [] };
    person.docs.push({ noteId: u.noteId, tokens });
    corpora.set(key, person);
  }
  return corpora;
}

/** Per-user IDF from per-person documents (one document = one person's whole corpus). */
export function computeIdf(corpora: Corpora): Map<string, number> {
  const df = new Map<string, number>();
  for (const person of corpora.values()) {
    const seen = new Set<string>();
    for (const d of person.docs) for (const t of d.tokens) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const P = corpora.size;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((P + 1) / (d + 1)) + 1);
  return idf;
}

const termFreq = (tokens: string[]): Map<string, number> => {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
};

/** TF over a person's utterances in notes OTHER than excludeNoteId (leave-one-meeting-out). */
export function signatureFor(corpora: Corpora, personKey: string, excludeNoteId: string | null): Map<string, number> {
  const toks: string[] = [];
  for (const d of corpora.get(personKey)?.docs ?? []) if (d.noteId !== excludeNoteId) toks.push(...d.tokens);
  return termFreq(toks);
}

function cosineTfidf(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, fa] of a) { const w = fa * (idf.get(t) ?? 0); na += w * w; const fb = b.get(t); if (fb) dot += w * (fb * (idf.get(t) ?? 0)); }
  for (const [t, fb] of b) { const w = fb * (idf.get(t) ?? 0); nb += w * w; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface Match { personKey: string; display: string; score: number; warm: boolean }

/** Rank every roster person's signature against a label's utterance text (open-set), best first. */
export function matchLabel(
  labelText: string,
  corpora: Corpora,
  idf: Map<string, number>,
  excludeNoteId: string | null,
  minSigTokens = DEFAULTS.minSigTokens,
): Match[] {
  const labelVec = termFreq(tokenize(labelText));
  if (labelVec.size === 0) return [];
  const matches: Match[] = [];
  for (const person of corpora.values()) {
    const otherTokens = person.docs.filter((d) => d.noteId !== excludeNoteId).reduce((n, d) => n + d.tokens.length, 0);
    const warm = otherTokens >= minSigTokens;
    const sig = signatureFor(corpora, person.key, excludeNoteId);
    const score = sig.size ? cosineTfidf(labelVec, sig, idf) : 0;
    matches.push({ personKey: person.key, display: person.display, score, warm });
  }
  return matches.sort((a, b) => b.score - a.score);
}

// Honest confidence, monotonic in top1 and in the margin (top1 - top2). Saturating so a modest
// bag-of-words cosine still maps into a usable range; the exact shape is TUNED on the backtest
// calibration table, not trusted as-is.
const sat = (x: number, k: number): number => (x > 0 ? x / (x + k) : 0);
export function confidenceFrom(top1: number, top2: number): number {
  const margin = Math.max(0, top1 - top2);
  return clamp01(0.6 * sat(top1, 0.25) + 0.4 * sat(margin, 0.12));
}

function resolveSpeakerId(display: string, roster: RosterEntry[]): string | null {
  const hit = roster.find((r) => sameName(r.name, display));
  return hit ? hit.speakerId : null;
}

/**
 * Decide per label: a WARM + STRONG signature match becomes a suggestion; everything else is a
 * fallback label the caller resolves with the LLM identifier. Pure.
 */
export function decideSuggestions(
  labels: Array<{ label: string; text: string }>,
  corpora: Corpora,
  idf: Map<string, number>,
  excludeNoteId: string | null,
  roster: RosterEntry[],
  selfName: string | null,
  opts: DecideOptions = {},
): { signature: SigSuggestion[]; fallbackLabels: string[] } {
  const { tScore, tMargin, minSigTokens } = { ...DEFAULTS, ...opts };
  const signature: SigSuggestion[] = [];
  const fallbackLabels: string[] = [];

  for (const { label, text } of labels) {
    const ranked = matchLabel(text, corpora, idf, excludeNoteId, minSigTokens);
    const top = ranked[0];
    const top1 = top?.score ?? 0;
    const top2 = ranked[1]?.score ?? 0;
    const margin = Math.max(0, top1 - top2);
    if (!top || !top.warm || top1 < tScore || margin < tMargin) {
      fallbackLabels.push(label);
      continue;
    }
    signature.push({
      label,
      name: top.display,
      speakerId: resolveSpeakerId(top.display, roster),
      confidence: confidenceFrom(top1, top2),
      isSelf: sameName(top.display, selfName),
      top1,
      margin,
    });
  }

  // Enforce "at most one self": if the signature stage picked self for more than one label, keep
  // the highest-confidence one as self and demote the rest to fallback (never two selves).
  const selves = signature.filter((s) => s.isSelf).sort((a, b) => b.confidence - a.confidence);
  for (const extra of selves.slice(1)) {
    const i = signature.indexOf(extra);
    if (i >= 0) { signature.splice(i, 1); fallbackLabels.push(extra.label); }
  }
  return { signature, fallbackLabels };
}
