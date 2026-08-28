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
// Re-tuned 2026-08-28 after H9 (stopwords + sublinear TF) sharpened the signature scores: the best
// operating point moved to t08/m02. Backtest sweep: SIG acc 61.4% (OFF 37.2% / ON 35.3%), non-self
// suggestion precision 59.0%, confident(>=0.8) picks 77.5% correct (27 wrong of 120 — honest for
// the ~0.8 band). Beats the pre-H9 t10/m08 (55.6% / 45.4% prec / 59% confident-correct).
const DEFAULTS: Required<DecideOptions> = { tScore: 0.08, tMargin: 0.02, minSigTokens: 8 };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// H9 (measured 2026-08-28, eval:speaker-signature A/B): drop high-frequency FILLER that is not
// discriminative of a speaker — Korean discourse fillers / connectives / backchannels + English
// stopwords. Everyone says these, so they add cosine noise; removing them + sublinear TF lifted
// open-set WARM signature accuracy 73.0% → 77.5% with no regression. Precision-first (only very
// common non-content tokens). Keep in sync with the eval probe's STOPWORDS.
const STOPWORDS = new Set<string>([
  '그래서', '그러니까', '그러면', '그런데', '근데', '그리고', '그거', '그게', '이제', '이거', '저기',
  '약간', '그냥', '진짜', '너무', '조금', '이렇게', '그렇게', '어떻게', '뭐지', '뭐야', '뭔가',
  '아니', '아니요', '아니에요', '맞아요', '그렇죠', '그쵸', '그럼', '네네', '알겠습니다', '있어요',
  '없어요', '해야', '하는', '하고', '해서', '해가지고', '있는', '있고', '거예요', '거죠', '건데',
  '같아요', '같은', '같이', '우리', '저희', '제가', '지금', '오늘', '내일', '어제', '한번', '일단',
  'the', 'and', 'that', 'this', 'with', 'for', 'you', 'yeah', 'okay', 'right', 'like', 'just',
  'have', 'are', 'was', 'but', 'not', 'they', 'them', 'there', 'here', 'what', 'about', 'kind',
  'gonna', 'wanna', 'really', 'actually', 'basically', 'something', 'because',
]);
// Content tokens: Korean runs (>=2 chars) + Latin words (>=2), minus non-discriminative fillers.
export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[가-힣]{2,}|[a-z]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
// Canonical person key: strip a parenthetical script variant, lowercase, collapse spaces.
export const canonName = (s: string): string =>
  s.replace(/\s*[(（【\[].*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');

// A non-person name that must never become a signature candidate: an echoed diarization label
// ("Speaker C", "Speaker 4") or the product name ("meeting note"), left in old data by a bad
// rename. Keep in sync with isNonPersonName in memory.ts / the identify-speakers edge fn.
export function isNonPersonName(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  if (/^(speaker|unknown|transcript)\b/i.test(t) || /^speaker\s*#?\s*\d+$/i.test(t)) return true;
  const lc = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  return lc === 'meetingnote' || lc === 'meetingnotes';
}

/** Group labeled utterances into per-person corpora, keyed by canonical name. */
export function buildCorpora(utterances: LabeledUtterance[]): Corpora {
  const corpora: Corpora = new Map();
  for (const u of utterances) {
    const display = (u.name ?? '').trim();
    const key = canonName(display);
    if (!key || isNonPersonName(display)) continue;
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

// Sublinear TF (1 + log tf), so a repeated word can't dominate the cosine (H9, measured lift).
const termFreq = (tokens: string[]): Map<string, number> => {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, c] of tf) tf.set(t, 1 + Math.log(c));
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

// Confidence for a PROMOTED pick (one that already passed tScore + tMargin, so it is evidence).
// A promoted warm signature match measured ~77% accurate in the ceiling probe, so anchor it near
// 0.8 and let a larger margin / top1 push toward ~0.9 — every promoted pick clears the 0.7 UI
// floor. Bag-of-words cosines are small in absolute terms, so this maps the MARGIN (not the raw
// cosine) into the band. Monotonic in top1 and margin. The exact shape is TUNED on the backtest
// calibration table (tighten tScore/tMargin if a high bucket is not actually accurate).
const sat = (x: number, k: number): number => (x > 0 ? x / (x + k) : 0);
export function confidenceFrom(top1: number, top2: number): number {
  const margin = Math.max(0, top1 - top2);
  return clamp01(0.72 + 0.16 * sat(margin, 0.08) + 0.08 * sat(top1, 0.25));
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
