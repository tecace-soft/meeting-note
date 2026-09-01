// Deterministic evidence-anchor layer over the text-only speaker identifier.
//
// The model confidently picks the WRONG same-team member (measured root cause; see
// SPEAKER_DISCRIMINABILITY_DESIGN.md). Prompt-level calibration already failed, so this gate
// lives in CODE: it extracts high-precision textual ANCHORS from the same transcript the model
// saw, then reshapes each suggestion's name/confidence against them — with NO extra LLM call.
//
// Three effects, in order of the evidence available for a label:
//   VETO  — a concrete NEGATIVE anchor contradicts a non-self suggestion  -> drop it, cap conf.
//   BOOST/OVERRIDE — a self-introduction confirms/corrects a NON-self pick -> set it at 0.9.
//   CAP   — a non-self pick with NO concrete anchor (pure role/topic guess) -> cap conf <= 0.6,
//           so "confident and wrong" is structurally impossible.
//
// SAFETY: this layer never DOWNGRADES or removes a self suggestion and never creates a new self,
// so the self path (and its recall) is untouched by construction — only NON-self outcomes change.
// It is pure and deterministic (no I/O), so it is unit-tested and replays identically in the
// backtest. Keep it behaviorally in sync with the web-UI copy in
// supabase/functions/identify-speakers/index.ts.

import type { SpeakerSuggestion, SpeakerRosterEntry } from './memory.js';

const CAP_NO_ANCHOR = 0.6; // non-self, no positive anchor: tentative suggestion, not "confident"
const CAP_VETOED = 0.35; // non-self contradicted by a negative anchor: near-abstain
const CONFIRM = 0.9; // self-introduction is strong evidence
const BOOTSTRAP_CONFIRM = 0.8; // H7: a corroborated self-intro of a NEW (non-roster) person — strong,
// but below a known-name self-intro (no roster cross-check), and tentative (speakerId null).

export type Anchor =
  | { kind: 'self-intro'; label: string; name: string } // POSITIVE: this label IS name
  | { kind: 'address'; label: string; name: string }; // NEGATIVE: this label is NOT name

// ---------------------------------------------------------------------------
// Name matching (cross-script). Roster names are often "Hansoo Lee (이한수)" — the Korean form
// lives in the parenthetical. A Korean vocative token ("한수") nests inside the Korean core
// ("이한수"); a Latin token ("hansoo") matches a whitespace-split part. Matching is precision-
// first: a candidate is only KEPT when it resolves to a known roster/self name, so a common noun
// before an honorific (e.g. "선생님" -> "선생") resolves to nothing and is ignored.
// ---------------------------------------------------------------------------

const hasHangul = (s: string): boolean => /[가-힣]/.test(s);
const hangulCore = (s: string): string => (s.toLowerCase().match(/[가-힣]+/g) ?? []).join('');
const stripParen = (s: string): string => s.toLowerCase().replace(/\s*[(（【\[].*$/, '').trim();
const latinParts = (s: string): string[] =>
  stripParen(s).replace(/[()（）【】\[\]·,]/g, ' ').split(/\s+/).filter((p) => p.length >= 2 && /[a-z]/.test(p));

/** Resolve an extracted candidate token to a known full name, or null. */
export function matchToken(token: string, knownNames: string[]): string | null {
  const t = token.trim().toLowerCase();
  if (t.length < 2) return null;
  for (const full of knownNames) {
    if (hasHangul(t)) {
      const core = hangulCore(full);
      if (core && (core.includes(t) || t.includes(core))) return full;
    } else if (latinParts(full).includes(t)) {
      return full;
    }
  }
  return null;
}

/** Do two full names refer to the same person? (cross-script, parenthetical-aware) */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (stripParen(a) && stripParen(a) === stripParen(b)) return true;
  const ha = hangulCore(a), hb = hangulCore(b);
  if (ha && hb && (ha.includes(hb) || hb.includes(ha))) return true;
  // Latin fallback, conservative: a BARE given name matches a full name only via the GIVEN
  // (first) token — never a shared surname ("Lee"), which would fuse two different teammates.
  const pa = latinParts(a), pb = latinParts(b);
  if (pa.length && pb.length) {
    if (pa.length === 1 && pa[0] === pb[0]) return true;
    if (pb.length === 1 && pb[0] === pa[0]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transcript parsing + anchor extraction
// ---------------------------------------------------------------------------

/** Split the labelled transcript ("Speaker A: text") into turns. A line beginning with a known
 *  label + ":" starts a turn; any other line continues the current turn (utterances rarely wrap,
 *  but stay robust). */
export function parseTurns(transcript: string, labels: string[]): Array<{ label: string; text: string }> {
  const known = new Set(labels.map((l) => l.trim()));
  const turns: Array<{ label: string; text: string }> = [];
  let current: { label: string; text: string } | null = null;
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const m = /^\s*([^:]{1,40}?):\s?(.*)$/.exec(line);
    if (m && known.has(m[1].trim())) {
      if (current) turns.push(current);
      current = { label: m[1].trim(), text: m[2] };
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  if (current) turns.push(current);
  return turns;
}

// Self-introduction: the SPEAKER states their own name (strong positive).
const SELF_INTRO_PATTERNS: RegExp[] = [
  /(?:제가|저는|나는|난|전)\s*([가-힣]{2,4}|[A-Za-z][A-Za-z]+)\s*(?:입니다|이에요|예요|이라고|라고|이라고요|라고요)/g,
  /(?:^|[\s"“'])(?:i['’`]m|i am|this is|my name is|name['’`]s)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/gi,
];
// Address / honorific: the speaker addresses or refers to a named person (strong negative — you
// do not attach an honorific to your own name, nor address yourself). Candidate must resolve to a
// known name, which is what keeps "선생님"/"고객님" out.
const ADDRESS_PATTERNS: RegExp[] = [
  /([가-힣]{2,4})\s*(?:님|씨)(?![가-힣])/g,
  /\b(?:thanks|thank you),?\s+([A-Z][a-zA-Z]+)\b/gi,
  /\b([A-Z][a-zA-Z]+),\s+(?:can|could|would|will|what|how|do|are|please)\b/g,
  /\bover to you,?\s+([A-Z][a-zA-Z]+)/gi,
];

function collect(patterns: RegExp[], text: string, knownNames: string[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const resolved = matchToken((m[1] ?? '').trim(), knownNames);
      if (resolved && !out.includes(resolved)) out.push(resolved);
    }
  }
  return out;
}

/** Extract high-precision anchors from the turns. Only names present in knownNames survive. */
export function extractAnchors(turns: Array<{ label: string; text: string }>, knownNames: string[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const turn of turns) {
    for (const name of collect(SELF_INTRO_PATTERNS, turn.text, knownNames)) {
      anchors.push({ kind: 'self-intro', label: turn.label, name });
    }
    for (const name of collect(ADDRESS_PATTERNS, turn.text, knownNames)) {
      // A speaker naming themselves via an honorific is not real; self-intro already covered the
      // positive, so an address anchor is only meaningful as "this speaker is NOT that person".
      anchors.push({ kind: 'address', label: turn.label, name });
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function rosterIdFor(name: string, roster: SpeakerRosterEntry[]): string | null {
  const hit = roster.find((r) => sameName(r.name, name));
  return hit ? hit.speakerId : null;
}

/** Reshape suggestions against the anchors. Pure; returns a new array. */
export function applyAnchors(
  suggestions: SpeakerSuggestion[],
  anchors: Anchor[],
  roster: SpeakerRosterEntry[],
  selfName: string | null,
): SpeakerSuggestion[] {
  // Per-label positive (self-intro) and negative (address) name sets.
  const positive = new Map<string, Set<string>>();
  const negative = new Map<string, Set<string>>();
  for (const a of anchors) {
    const bucket = a.kind === 'self-intro' ? positive : negative;
    const set = bucket.get(a.label) ?? new Set<string>();
    set.add(a.name);
    bucket.set(a.label, set);
  }

  return suggestions.map((s) => {
    const posSet = positive.get(s.label);
    // A single, unambiguous self-intro name for this label; ambiguous (>1) positives are ignored.
    const posName = posSet && posSet.size === 1 ? [...posSet][0] : null;
    const posIsSelf = posName != null && sameName(posName, selfName);

    // A) self-introduction naming a NON-self roster member: confirm or correct the pick.
    if (posName && !posIsSelf) {
      if (s.name && sameName(s.name, posName)) {
        return { ...s, confidence: Math.max(s.confidence, CONFIRM) };
      }
      return {
        label: s.label,
        name: posName,
        speakerId: rosterIdFor(posName, roster),
        confidence: CONFIRM,
        isSelf: false,
        rationale: `self-introduction anchor: "${posName}"`,
      };
    }

    // B) self-introduction naming the SELF: only BOOST an already-self label. Never flip a
    //    non-self label to self here — that protects the self path from dual-self / regressions.
    if (posName && posIsSelf && s.isSelf) {
      return { ...s, confidence: Math.max(s.confidence, CONFIRM) };
    }

    // C) negative veto: a non-self pick this label is addressed-as-not.
    const negSet = negative.get(s.label);
    if (!s.isSelf && s.name && negSet && [...negSet].some((n) => sameName(s.name, n))) {
      return {
        label: s.label,
        name: null,
        speakerId: null,
        confidence: Math.min(s.confidence, CAP_VETOED),
        isSelf: false,
        rationale: `contradicted by address anchor`,
      };
    }

    // D) cap a non-self pick that has NO concrete positive anchor.
    if (!s.isSelf && s.name) {
      return { ...s, confidence: Math.min(s.confidence, CAP_NO_ANCHOR) };
    }
    return s;
  });
}

// ---------------------------------------------------------------------------
// H7 — cold-start anchor bootstrap. The extractors above keep ONLY names already
// in the roster/self (matchToken gate), so a first-time participant who introduces
// themselves is dropped — the exact signal that identifies a new person is thrown
// away. discoverBootstrapNames finds names that do NOT resolve to knownNames and
// are CORROBORATED (>=2 independent anchor hits, spanning >=2 labels or >=2 kinds),
// so a one-off common-noun misfire ("저는 담당자입니다") can't become a name. An
// optional role-noun stoplist is an extra guard. Suggestion-only; the caller expands
// knownNames + roster with these tentative names and reuses applyAnchors. See
// SPEAKER_H7_ANCHOR_BOOTSTRAP_DESIGN.md.
// ---------------------------------------------------------------------------

// Obvious NON-name role/honorific nouns that can precede 입니다 / 님 — never a person.
export const ROLE_STOPLIST = new Set<string>([
  '담당자', '개발자', '디자이너', '기획자', '엔지니어', '매니저', '관리자', '책임자', '작업자', '운영자',
  '대표', '사장', '부장', '과장', '차장', '대리', '팀장', '실장', '본부장', '이사', '상무', '전무',
  '선생', '교수', '강사', '고객', '손님', '회원', '사용자', '여러분', '참석자', '발표자', '진행자', '사회자',
]);
const isNameShape = (s: string): boolean => /^[가-힣]{2,4}$/.test(s.trim()) || /^[A-Za-z][a-zA-Z]+( [A-Z][a-zA-Z]+)?$/.test(s.trim());
// Group by the given (first) token so "Michael Knutsen" and "Michael" corroborate each other.
const nameKey = (s: string): string => { const m = s.trim().toLowerCase().match(/[가-힣]{2,4}|[a-z]+/); return m ? m[0] : s.trim().toLowerCase(); };

interface NameHit { name: string; kind: 'self-intro' | 'address'; label: string }
function rawHits(turns: Array<{ label: string; text: string }>, patterns: RegExp[], kind: NameHit['kind']): NameHit[] {
  const out: NameHit[] = [];
  for (const turn of turns) for (const re of patterns) for (const m of turn.text.matchAll(re)) {
    const raw = (m[1] ?? '').trim();
    if (raw) out.push({ name: raw, kind, label: turn.label });
  }
  return out;
}

/** Find corroborated NEW (non-roster) speaker names + their self-intro label assignment. Pure. */
export function discoverBootstrapNames(
  turns: Array<{ label: string; text: string }>,
  knownNames: string[],
  opts: { stoplist?: boolean } = {},
): { newNames: string[]; assignment: Map<string, string> } {
  const useStop = opts.stoplist !== false;
  const hits = [...rawHits(turns, SELF_INTRO_PATTERNS, 'self-intro'), ...rawHits(turns, ADDRESS_PATTERNS, 'address')]
    .filter((h) => isNameShape(h.name) && !matchToken(h.name, knownNames) && !(useStop && ROLE_STOPLIST.has(nameKey(h.name))));
  const byName = new Map<string, { display: string; hits: NameHit[] }>();
  for (const h of hits) {
    const k = nameKey(h.name);
    const e = byName.get(k) ?? { display: h.name, hits: [] };
    if (h.name.length > e.display.length) e.display = h.name; // prefer the fuller form (adds a surname)
    e.hits.push(h);
    byName.set(k, e);
  }
  const newNames: string[] = [];
  const assignment = new Map<string, string>();
  for (const { display, hits: hs } of byName.values()) {
    const distinctLabels = new Set(hs.map((h) => h.label)).size;
    const distinctKinds = new Set(hs.map((h) => h.kind)).size;
    if (!(hs.length >= 2 && (distinctLabels >= 2 || distinctKinds >= 2))) continue; // corroboration
    newNames.push(display);
    const selfLabels = new Set(hs.filter((h) => h.kind === 'self-intro').map((h) => h.label));
    if (selfLabels.size === 1) assignment.set([...selfLabels][0], display); // unique self-intro → assign
  }
  return { newNames, assignment };
}

/** Convenience: extract from the transcript + roster and apply, in one call. `opts.bootstrap`
 *  (H7) additionally surfaces corroborated NEW speaker names; default off = unchanged behavior. */
export function gateSuggestionsWithAnchors(
  suggestions: SpeakerSuggestion[],
  transcript: string,
  labels: string[],
  roster: SpeakerRosterEntry[],
  selfName: string | null,
  opts: { bootstrap?: boolean; stoplist?: boolean } = {},
): SpeakerSuggestion[] {
  const knownNames = [...roster.map((r) => r.name), ...(selfName ? [selfName] : [])].filter(Boolean);
  const turns = parseTurns(transcript, labels);

  let effRoster = roster;
  let effKnown = knownNames;
  let bootstrapped = new Set<string>();
  if (opts.bootstrap) {
    const { newNames } = discoverBootstrapNames(turns, knownNames, { stoplist: opts.stoplist });
    if (newNames.length) {
      bootstrapped = new Set(newNames.map((n) => n.toLowerCase()));
      effKnown = [...knownNames, ...newNames];
      effRoster = [...roster, ...newNames.map((n) => ({ speakerId: '', name: n, summary: '' } as SpeakerRosterEntry))];
    }
  }
  if (effKnown.length === 0) return suggestions;

  // extractAnchors now resolves the new names, so their self-intro is a positive anchor (effect A
  // assigns the label) and their address is a veto. Empty anchors still apply the CAP.
  const anchors = extractAnchors(turns, effKnown);
  const gated = applyAnchors(suggestions, anchors, effRoster, selfName);
  if (bootstrapped.size === 0) return gated;

  // A bootstrapped (non-roster) name stays a TENTATIVE suggestion: speakerId null (create on
  // confirm), confidence capped to BOOTSTRAP_CONFIRM (below a known-name self-intro's 0.9).
  return gated.map((s) => (s.name && !s.isSelf && bootstrapped.has(s.name.toLowerCase())
    ? { ...s, speakerId: null, confidence: Math.min(s.confidence, BOOTSTRAP_CONFIRM), rationale: 'bootstrapped new speaker (corroborated self-intro)' }
    : s));
}
