// CEILING PROBE: can a per-speaker TEXT SIGNATURE tell same-team members apart? (read-only, NO LLM)
//
// The measured root cause of low speaker-ID accuracy is within-roster CONFUSION: the model
// confidently picks the wrong same-team member because their profiles describe overlapping
// roles/topics, and explicit naming events (self-intro/vocative) are rare. Before building a
// production "discriminative signature" identifier, this probe measures whether the signal even
// EXISTS: build each roster member's signature from their PAST labeled utterances (leave the
// target meeting OUT), then match each anonymous label in a meeting to the nearest signature.
//
// Representation: TF-IDF bag-of-words cosine (zero cost, deterministic). If even TF-IDF beats the
// ~37% identify baseline, discriminative signatures have headroom (embeddings would do better). If
// it is at chance, same-team utterances are genuinely non-distinctive and NO text method will help
// — a valuable result to report to the boss.
//
// Two settings:
//   closed-set  candidates = the meeting's TRUE participants (we already know who is in the room,
//               e.g. from an attendee list). This is the pure DISCRIMINABILITY ceiling.
//   open-set    candidates = the user's whole roster (the harder, realistic setting).
//
// Leave-one-out: a candidate's signature is built ONLY from notes other than the target, so the
// answer is never read off the meeting being scored. "warm" = the true speaker has >=1 utterance
// in some other note (a signature is possible); the warm-subset accuracy is the real ceiling.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Run: `npm run eval:speaker-signature`.
// Tunables: SIG_USERS (csv or "all"), SIG_NOTES_PER_USER (default 40), SIG_MIN_NAMED (default 2),
// SIG_SCAN_LIMIT (default 500).

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { norm } from './lib/util.js';

config();

const NOTES_PER_USER = clampInt(process.env.SIG_NOTES_PER_USER, 40, 2, 200);
const MIN_NAMED = clampInt(process.env.SIG_MIN_NAMED, 2, 1, 10);
const SCAN_LIMIT = clampInt(process.env.SIG_SCAN_LIMIT, 500, 50, 5000);

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }

const isAnonName = (s: string): boolean => /^speaker\s/i.test(s.trim()) || s.trim() === '' || /^unknown/i.test(s.trim());
// Canonical person key: strip a parenthetical script variant so "Andrew Yoo (유영준)" and
// "Andrew Yoo" are the same person across notes.
const canonName = (s: string): string => norm(s.replace(/\s*[(（【\[].*$/, ''));
// Content tokens: Korean runs (>=2 chars) + Latin words (>=2). Drops 1-char noise + digits.
const tokenize = (s: string): string[] => (s.toLowerCase().match(/[가-힣]{2,}|[a-z]{2,}/g) ?? []);

// One label inside one note: its true person (or null) and its concatenated utterance text.
interface LabelInstance { noteId: string; trueKey: string | null; trueRaw: string | null; text: string }
// A note reduced to its labels (only notes with >=MIN_NAMED distinct real names qualify as targets).
interface NoteCase { noteId: string; labels: LabelInstance[]; participantKeys: string[] }

function toLabels(note: NoteRow): LabelInstance[] | null {
  const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
  const keyed = segs.filter((s) => s && typeof s.text === 'string' && typeof s.speakerKey === 'string' && (s.speakerKey as string).trim());
  if (keyed.length === 0 || keyed.length < segs.length) return null;
  const byLabel = new Map<string, { trueRaw: string | null; parts: string[] }>();
  for (const s of keyed) {
    const key = (s.speakerKey as string).trim();
    const disp = typeof s.speaker === 'string' ? (s.speaker as string).trim() : '';
    const real = disp && !isAnonName(disp) ? disp : null;
    const e = byLabel.get(key) ?? { trueRaw: null, parts: [] };
    if (real && !e.trueRaw) e.trueRaw = real;
    e.parts.push(s.text as string);
    byLabel.set(key, e);
  }
  return [...byLabel.entries()].map(([, v]) => ({
    noteId: note.id, trueRaw: v.trueRaw, trueKey: v.trueRaw ? canonName(v.trueRaw) : null, text: v.parts.join(' '),
  }));
}

async function loadUserNotes(db: SupabaseClient, userId: string): Promise<NoteRow[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(NOTES_PER_USER);
  return (data ?? []) as NoteRow[];
}

async function discoverUsers(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization')
    .order('created_at', { ascending: false }).limit(SCAN_LIMIT);
  const rows = (data ?? []) as NoteRow[];
  const byUser = new Map<string, number>();
  for (const r of rows) {
    if (!r.user_id) continue;
    const labels = toLabels(r);
    if (labels && new Set(labels.filter((l) => l.trueKey).map((l) => l.trueKey)).size >= MIN_NAMED) {
      byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1);
    }
  }
  return [...byUser.entries()].filter(([, n]) => n >= 2).map(([u]) => u);
}

// ---- TF-IDF cosine over a fixed IDF (computed once per user from full corpora) ----
function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
function cosineTfidf(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, fa] of a) { const w = fa * (idf.get(t) ?? 0); na += w * w; if (b.has(t)) dot += w * (b.get(t)! * (idf.get(t) ?? 0)); }
  for (const [t, fb] of b) { const w = fb * (idf.get(t) ?? 0); nb += w * w; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

interface Tally { total: number; correct: number }
const add = (t: Tally, ok: boolean) => { t.total += 1; if (ok) t.correct += 1; };
const pctOf = (t: Tally): string => (t.total ? `${((t.correct / t.total) * 100).toFixed(1)}%` : '  -  ');

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) { process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const arg = (process.env.SIG_USERS || 'all').trim();
  const users = arg && arg !== 'all' ? arg.split(',').map((u) => u.trim()).filter(Boolean) : await discoverUsers(db);

  process.stdout.write(`\nSPEAKER SIGNATURE CEILING PROBE (TF-IDF, no LLM) — users=${users.length}  notes/user<=${NOTES_PER_USER}\n\n`);

  const closed: Tally = { total: 0, correct: 0 };
  const closedWarm: Tally = { total: 0, correct: 0 };
  const open: Tally = { total: 0, correct: 0 };
  const openWarm: Tally = { total: 0, correct: 0 };
  let randomExpected = 0, randomN = 0; // sum of 1/|participants| over closed-set labels (chance baseline)

  for (const userId of users) {
    const notes = await loadUserNotes(db, userId);
    const cases: NoteCase[] = [];
    // person key -> list of { noteId, tokens } across ALL the user's notes (for signatures + IDF)
    const corpus = new Map<string, Array<{ noteId: string; tokens: string[] }>>();
    for (const n of notes) {
      const labels = toLabels(n);
      if (!labels) continue;
      for (const l of labels) {
        if (!l.trueKey) continue;
        const arrp = corpus.get(l.trueKey) ?? [];
        arrp.push({ noteId: l.noteId, tokens: tokenize(l.text) });
        corpus.set(l.trueKey, arrp);
      }
      const participantKeys = [...new Set(labels.filter((l) => l.trueKey).map((l) => l.trueKey as string))];
      if (participantKeys.length >= MIN_NAMED) cases.push({ noteId: n.id, labels, participantKeys });
    }
    const roster = [...corpus.keys()];
    if (roster.length < 2 || cases.length === 0) continue;

    // Per-user IDF from full per-person corpora (one document per person).
    const df = new Map<string, number>();
    for (const [, docs] of corpus) {
      const seen = new Set<string>();
      for (const d of docs) for (const t of d.tokens) seen.add(t);
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const P = corpus.size;
    const idf = new Map<string, number>();
    for (const [t, d] of df) idf.set(t, Math.log((P + 1) / (d + 1)) + 1);

    // signature(personKey, excludeNoteId) = TF over that person's utterances in OTHER notes.
    const signature = (personKey: string, excludeNoteId: string): Map<string, number> => {
      const toks: string[] = [];
      for (const d of corpus.get(personKey) ?? []) if (d.noteId !== excludeNoteId) toks.push(...d.tokens);
      return termFreq(toks);
    };
    const hasHistory = (personKey: string, excludeNoteId: string): boolean =>
      (corpus.get(personKey) ?? []).some((d) => d.noteId !== excludeNoteId && d.tokens.length > 0);

    for (const c of cases) {
      for (const l of c.labels) {
        if (!l.trueKey) continue; // only score labels with a ground-truth name
        const labelVec = termFreq(tokenize(l.text));
        if (labelVec.size === 0) continue;
        const warm = hasHistory(l.trueKey, c.noteId);

        const scoreAgainst = (candidates: string[]): string | null => {
          let best: string | null = null, bestScore = -1;
          for (const cand of candidates) {
            const sig = signature(cand, c.noteId);
            if (sig.size === 0) continue;
            const sc = cosineTfidf(labelVec, sig, idf);
            if (sc > bestScore) { bestScore = sc; best = cand; }
          }
          return best;
        };

        // closed-set: candidates = this meeting's true participants
        const closedPred = scoreAgainst(c.participantKeys);
        const okClosed = closedPred === l.trueKey;
        add(closed, okClosed);
        if (warm) add(closedWarm, okClosed);
        randomExpected += 1 / Math.max(1, c.participantKeys.length); randomN += 1;

        // open-set: candidates = the whole roster (any person with a corpus)
        const openPred = scoreAgainst(roster);
        const okOpen = openPred === l.trueKey;
        add(open, okOpen);
        if (warm) add(openWarm, okOpen);
      }
    }
    process.stdout.write(`• ${userId.slice(0, 8)}…  roster=${roster.length}  cases=${cases.length}\n`);
  }

  const chance = randomN ? randomExpected / randomN : 0;
  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write('SIGNATURE-MATCH ACCURACY (TF-IDF cosine, leave-one-meeting-out)\n');
  process.stdout.write(`  random-within-set chance:        ${(chance * 100).toFixed(1)}%\n`);
  process.stdout.write(`  identify baseline (for ref):     ~37%  (eval:speaker-backtest full arm)\n`);
  process.stdout.write(`  closed-set (know the attendees): ${pctOf(closed)}  (n=${closed.total})\n`);
  process.stdout.write(`    warm subset (has history):     ${pctOf(closedWarm)}  (n=${closedWarm.total})\n`);
  process.stdout.write(`  open-set (whole roster):         ${pctOf(open)}  (n=${open.total})\n`);
  process.stdout.write(`    warm subset (has history):     ${pctOf(openWarm)}  (n=${openWarm.total})\n`);
  process.stdout.write('\nRead: closed-set WARM well above chance = discriminative text signal EXISTS (build it, likely\n');
  process.stdout.write('stronger with embeddings). Closed-set ≈ chance = same-team utterances are non-distinctive and\n');
  process.stdout.write('no text signature will help — report the ceiling to the boss instead of building it.\n');
}

main().catch((e) => { process.stderr.write(`signature-probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
