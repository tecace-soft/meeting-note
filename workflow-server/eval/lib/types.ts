// F8 evaluation harness — shared types.
//
// A "golden" case is hand-authored ground truth for one meeting. A "surface" runs
// one producer (insight extraction / memory fold / search) against its golden set
// and returns a SurfaceScore. run.ts aggregates and reports them.

/** Ground truth for the note_insight extraction surface. */
export interface InsightGolden {
  name: string;
  noteId?: string;
  transcript: string;
  // Optional speaker-name hint (maps generic "Speaker A/B" labels to real people), the
  // same context the summary path passes. When present, the surface scores action-owner
  // attribution (owner coverage + owner recall vs expectedOwners) — the regression signal
  // for the owner-attribution fix.
  speakerContext?: string;
  expectedOwners?: string[];
  // Expected values are hand-authored from the transcript. actions/decisions/topics
  // are graded semantically (LLM judge, paraphrase/translation OK); people/companies
  // are graded deterministically (names are exact-ish).
  expected: {
    actions: string[];
    decisions: string[];
    topics: string[];
    people: string[];
    companies: string[];
  };
}

/** Ground truth for the personal-memory fold surface. */
export interface MemoryGolden {
  name: string;
  noteId?: string;
  selfName: string | null;
  // Prior memory the fold starts from. Seeded so subjects the meeting re-mentions
  // ALREADY exist — a good fold updates/supersedes them instead of adding parallels.
  priorMemory: { version: 2; items: Array<{ id: string; text: string; entities?: string[] }> };
  transcript: string;
  // Subjects present in BOTH prior memory and this meeting. Each should end as exactly
  // one active item after the fold (dedup signal).
  recurringSubjects: string[];
  // Claims the resulting memory must NOT assert as current fact (unsupported or
  // not-yet-final in the transcript). Each is checked by the judge (fact-drift signal).
  forbiddenAssertions: Array<{ claim: string; why: string }>;
}

/** Ground truth for the F5 speaker-identification surface. */
export interface SpeakerIdGolden {
  name: string;
  noteId?: string;
  transcript: string; // generic "Speaker A/B" labeled, as at ingest
  roster: Array<{ speakerId: string; name: string; summary?: string }>;
  selfName?: string;
  labels: string[]; // anonymous labels to identify
  // Ground-truth identity per label. name = the real person; null = genuinely unknowable
  // from text, so the identifier SHOULD abstain (leaving it unknown is correct).
  expected: Array<{ label: string; name: string | null }>;
}

/** Ground truth for the search_notes retrieval surface. */
export interface SearchGolden {
  name: string;
  userId: string;
  queries: Array<{ query: string; expectedNoteIds: string[] }>;
}

export interface Metric {
  label: string;
  value: number; // score in [0,1] where higher is better, unless label ends with "(count, lower better)"
  detail?: string;
}

export interface SurfaceScore {
  surface: string;
  ran: boolean;
  skippedReason?: string;
  metrics: Metric[];
  notes: string[];
}

/** Runtime dependencies injected into surfaces/judge (Power-of-Ten rule 9). */
export interface EvalDeps {
  geminiApiKey: string;
  judgeModel: string;
  // Fixed clock so memory-fold runs are reproducible.
  now: string;
}
