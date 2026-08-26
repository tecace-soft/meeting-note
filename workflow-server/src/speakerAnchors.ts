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

/** Convenience: extract from the transcript + roster and apply, in one call. */
export function gateSuggestionsWithAnchors(
  suggestions: SpeakerSuggestion[],
  transcript: string,
  labels: string[],
  roster: SpeakerRosterEntry[],
  selfName: string | null,
): SpeakerSuggestion[] {
  const knownNames = [...roster.map((r) => r.name), ...(selfName ? [selfName] : [])].filter(Boolean);
  if (knownNames.length === 0) return suggestions;
  const anchors = extractAnchors(parseTurns(transcript, labels), knownNames);
  if (anchors.length === 0) {
    // Still apply the CAP so a no-evidence confident pick can never be shown as confident.
    return applyAnchors(suggestions, [], roster, selfName);
  }
  return applyAnchors(suggestions, anchors, roster, selfName);
}
