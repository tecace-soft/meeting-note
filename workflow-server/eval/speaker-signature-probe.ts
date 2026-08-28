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
import { tokenize as prodTokenize } from '../src/speakerSignature.js';

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
const tokenizeBase = (s: string): string[] => (s.toLowerCase().match(/[가-힣]{2,}|[a-z]{2,}/g) ?? []);

// H9 (IDF tuning) — remove high-frequency FILLER that is not discriminative of a speaker: Korean
// discourse fillers / connectives / backchannels + English stopwords. Everyone says these, so
// they add cosine noise. Precision-first: only very common non-content tokens.
const STOPWORDS = new Set<string>([
  // Korean fillers / connectives / backchannels / generic verbs
  '그래서', '그러니까', '그러면', '그런데', '근데', '그리고', '그거', '그게', '이제', '이거', '저기',
  '약간', '그냥', '진짜', '너무', '조금', '좀', '이렇게', '그렇게', '어떻게', '뭐지', '뭐야', '뭔가',
  '아니', '아니요', '아니에요', '맞아요', '그렇죠', '그쵸', '그럼', '네네', '알겠습니다', '있어요',
  '없어요', '해야', '하는', '하고', '해서', '해가지고', '있는', '있고', '거예요', '거죠', '건데',
  '같아요', '같은', '같이', '우리', '저희', '제가', '지금', '오늘', '내일', '어제', '한번', '일단',
  // English stopwords
  'the', 'and', 'that', 'this', 'with', 'for', 'you', 'yeah', 'okay', 'right', 'like', 'just',
  'have', 'are', 'was', 'but', 'not', 'they', 'them', 'there', 'here', 'what', 'about', 'kind',
  'gonna', 'wanna', 'really', 'actually', 'basically', 'something', 'because',
]);
const tokenizeH9 = (s: string): string[] => tokenizeBase(s).filter((t) => !STOPWORDS.has(t));

// H3 (bigrams) TESTED 2026-08-28 → NEGATIVE (identical to base): word pairs are too sparse at this
// data size (few notes per person), so a leave-one-out signature rarely shares an exact bigram.
// Kept the tokenizer for reference; not used in the shipped arm.
const tokenizeH3 = (s: string): string[] => {
  const uni = tokenizeH9(s);
  const out = [...uni];
  for (let i = 0; i + 1 < uni.length; i += 1) out.push(`2:${uni[i]}_${uni[i + 1]}`);
  return out;
};

// H4 — ROLE / INTERACTION-STANCE features, added on top of H9 content words. Content signatures
// need HISTORY (cold speakers have none); a person's conversational STANCE (who ASKS/DIRECTS vs who
// REPORTS/DEFERS) is a different axis that can separate same-team members and works even with thin
// history. Encode each utterance's stance as special tokens (prefixed "r:") from cheap surface
// cues, so a person who consistently directs accumulates "r:direct" mass vs a reporter's "r:report".
const R_DIRECT = [/어때요|어떻게 생각|해주세요|해달라|하면 좋겠|합시다|해야 (?:돼|되|할)|정리해|확인해|검토|보내주|주세요/];
const R_REPORT = [/했습니다|완료|끝냈|진행했|해봤|확인했|만들었|적용했|배포했|테스트해/];
const R_ASK = [/\?|나요|까요|인가요|건가요|맞나요|무엇|언제|어디|누가|왜/];
const R_DEFER = [/알겠습니다|알겠어요|네네|그렇게 하겠|그러겠|맞아요|동의/];
function roleTokens(text: string): string[] {
  const out: string[] = [];
  const hit = (res: RegExp[]) => res.some((re) => re.test(text));
  if (hit(R_DIRECT)) out.push('r:direct');
  if (hit(R_REPORT)) out.push('r:report');
  if (hit(R_ASK)) out.push('r:ask');
  if (hit(R_DEFER)) out.push('r:defer');
  return out;
}
// Per-utterance role tokens are emitted at the SEGMENT level in real data; here the label text is
// already the person's concatenated utterances, so we scan the whole blob and weight role tokens so
// they are comparable to content mass without swamping it.
const ROLE_WEIGHT = 6;
const tokenizeH4 = (s: string): string[] => {
  const content = tokenizeH9(s);
  const roles = roleTokens(s);
  const weighted: string[] = [];
  for (const r of roles) for (let i = 0; i < ROLE_WEIGHT; i += 1) weighted.push(r);
  return [...content, ...weighted];
};

// H5 — META features: a speaker's utterance-length HABITS (short backchannels vs long explanations)
// are a stable style axis independent of content. On the label's concatenated blob we can only see
// aggregate style, so we bucket the average token-run length + the share of very short vs long
// utterances into coarse tokens (prefixed "m:") so a terse speaker vs a verbose one separate.
function metaTokens(s: string): string[] {
  // Split into utterances on sentence-ish boundaries; measure content-token counts per utterance.
  const utts = s.split(/[.?!。？！\n]+/).map((u) => tokenizeH9(u).length).filter((n) => n > 0);
  if (utts.length === 0) return [];
  const avg = utts.reduce((a, b) => a + b, 0) / utts.length;
  const shortShare = utts.filter((n) => n <= 2).length / utts.length;
  const longShare = utts.filter((n) => n >= 12).length / utts.length;
  const avgBucket = avg <= 3 ? 'lo' : avg <= 8 ? 'mid' : 'hi';
  const shortBucket = shortShare >= 0.4 ? 'terse' : shortShare >= 0.2 ? 'some' : 'few';
  const longBucket = longShare >= 0.2 ? 'verbose' : 'notlong';
  return [`m:avg_${avgBucket}`, `m:short_${shortBucket}`, `m:long_${longBucket}`];
}
const META_WEIGHT = 5;
const tokenizeH5 = (s: string): string[] => {
  const out = prodTokenize(s); // shipped features (H9 + H4)
  for (const m of metaTokens(s)) for (let i = 0; i < META_WEIGHT; i += 1) out.push(m);
  return out;
};
// H5 (meta/style) TESTED 2026-08-28 → slightly NEGATIVE (open-WARM 82.0% → 80.9%): coarse
// utterance-length buckets add noise, not signal, on top of the already-strong H4 base. Not shipped.

// base = SHIPPED tokenizer (prodTokenize = H9 + H4). h6 = base tokenizer + an ATTENDANCE PRIOR in
// SCORING: a candidate who appears in MORE of the user's notes is a-priori more likely present, so
// nudge the cosine by + PRIOR_WEIGHT * log(1 + noteCount). This is a scoring change, not a
// tokenizer change, so h6 shares base's tokenizer and only the scoreAgainst differs.
const TOKENIZERS: Record<string, (s: string) => string[]> = { base: prodTokenize, h6: prodTokenize };
const SUBLINEAR: Record<string, boolean> = { base: true, h6: true };
const PRIOR_WEIGHT = 0.02;
const ARMS = ['base', 'h6'] as const;
type Arm = typeof ARMS[number];

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
function termFreq(tokens: string[], sublinear = false): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  if (sublinear) for (const [t, c] of tf) tf.set(t, 1 + Math.log(c));
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

  process.stdout.write(`\nSPEAKER SIGNATURE PROBE (TF-IDF, no LLM) — H6 attendance-prior A/B — users=${users.length}  notes/user<=${NOTES_PER_USER}\n\n`);

  // Per-arm tallies (base = shipped H9+H4, h5 = + meta/style).
  const T = (): { closed: Tally; closedWarm: Tally; open: Tally; openWarm: Tally } =>
    ({ closed: { total: 0, correct: 0 }, closedWarm: { total: 0, correct: 0 }, open: { total: 0, correct: 0 }, openWarm: { total: 0, correct: 0 } });
  const tallies: Record<Arm, ReturnType<typeof T>> = { base: T(), h6: T() };
  let randomExpected = 0, randomN = 0; // sum of 1/|participants| over closed-set labels (chance baseline)

  for (const userId of users) {
    const notes = await loadUserNotes(db, userId);
    // Build a per-arm corpus (different tokenizers → different token streams + IDF).
    const cases: NoteCase[] = [];
    const corpusByArm: Record<Arm, Map<string, Array<{ noteId: string; tokens: string[] }>>> = { base: new Map(), h6: new Map() };
    for (const n of notes) {
      const labels = toLabels(n);
      if (!labels) continue;
      for (const l of labels) {
        if (!l.trueKey) continue;
        for (const arm of ARMS) {
          const arrp = corpusByArm[arm].get(l.trueKey) ?? [];
          arrp.push({ noteId: l.noteId, tokens: TOKENIZERS[arm](l.text) });
          corpusByArm[arm].set(l.trueKey, arrp);
        }
      }
      const participantKeys = [...new Set(labels.filter((l) => l.trueKey).map((l) => l.trueKey as string))];
      if (participantKeys.length >= MIN_NAMED) cases.push({ noteId: n.id, labels, participantKeys });
    }
    const roster = [...corpusByArm.base.keys()];
    if (roster.length < 2 || cases.length === 0) continue;

    // Per-arm IDF + signature/hasHistory closures.
    const scorer = (arm: Arm) => {
      const corpus = corpusByArm[arm];
      const df = new Map<string, number>();
      for (const [, docs] of corpus) {
        const seen = new Set<string>();
        for (const d of docs) for (const t of d.tokens) seen.add(t);
        for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
      }
      const P = corpus.size;
      const idf = new Map<string, number>();
      for (const [t, d] of df) idf.set(t, Math.log((P + 1) / (d + 1)) + 1);
      const signature = (personKey: string, excludeNoteId: string): Map<string, number> => {
        const toks: string[] = [];
        for (const d of corpus.get(personKey) ?? []) if (d.noteId !== excludeNoteId) toks.push(...d.tokens);
        return termFreq(toks, SUBLINEAR[arm]);
      };
      const hasHistory = (personKey: string, excludeNoteId: string): boolean =>
        (corpus.get(personKey) ?? []).some((d) => d.noteId !== excludeNoteId && d.tokens.length > 0);
      // H6 attendance prior: distinct OTHER notes this person appears in (frequency = presence prior).
      const noteCount = (personKey: string, excludeNoteId: string): number =>
        new Set((corpus.get(personKey) ?? []).filter((d) => d.noteId !== excludeNoteId).map((d) => d.noteId)).size;
      return { idf, signature, hasHistory, noteCount };
    };
    const scorers: Record<Arm, ReturnType<typeof scorer>> = { base: scorer('base'), h6: scorer('h6') };

    for (const c of cases) {
      for (const l of c.labels) {
        if (!l.trueKey) continue; // only score labels with a ground-truth name
        // Chance baseline is arm-independent; count once per label (using base's non-empty check).
        if (termFreq(TOKENIZERS.base(l.text)).size > 0) { randomExpected += 1 / Math.max(1, c.participantKeys.length); randomN += 1; }
        for (const arm of ARMS) {
          const { idf, signature, hasHistory, noteCount } = scorers[arm];
          const labelVec = termFreq(TOKENIZERS[arm](l.text), SUBLINEAR[arm]);
          if (labelVec.size === 0) continue;
          const warm = hasHistory(l.trueKey, c.noteId);
          const usePrior = arm === 'h6';
          const scoreAgainst = (candidates: string[]): string | null => {
            let best: string | null = null, bestScore = -1;
            for (const cand of candidates) {
              const sig = signature(cand, c.noteId);
              if (sig.size === 0) continue;
              let sc = cosineTfidf(labelVec, sig, idf);
              if (usePrior) sc += PRIOR_WEIGHT * Math.log(1 + noteCount(cand, c.noteId));
              if (sc > bestScore) { bestScore = sc; best = cand; }
            }
            return best;
          };
          const t = tallies[arm];
          const okClosed = scoreAgainst(c.participantKeys) === l.trueKey;
          add(t.closed, okClosed); if (warm) add(t.closedWarm, okClosed);
          const okOpen = scoreAgainst(roster) === l.trueKey;
          add(t.open, okOpen); if (warm) add(t.openWarm, okOpen);
        }
      }
    }
    process.stdout.write(`• ${userId.slice(0, 8)}…  roster=${roster.length}  cases=${cases.length}\n`);
  }

  const chance = randomN ? randomExpected / randomN : 0;
  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write('SIGNATURE-MATCH ACCURACY — base (shipped) vs H6 (+ attendance prior)\n');
  process.stdout.write(`  random-within-set chance: ${(chance * 100).toFixed(1)}%   identify baseline (ref): ~37%\n\n`);
  process.stdout.write('arm    closed-set      closed-WARM     open-set        open-WARM\n');
  for (const arm of ARMS) {
    const t = tallies[arm];
    process.stdout.write(
      `${arm.padEnd(6)} ${pctOf(t.closed).padStart(6)}(${String(t.closed.total).padStart(3)})   ` +
      `${pctOf(t.closedWarm).padStart(6)}(${String(t.closedWarm.total).padStart(3)})   ` +
      `${pctOf(t.open).padStart(6)}(${String(t.open.total).padStart(3)})   ` +
      `${pctOf(t.openWarm).padStart(6)}(${String(t.openWarm.total).padStart(3)})\n`,
    );
  }
  process.stdout.write('\nRead: H6 open-WARM > base = attendance prior helps disambiguate; ship the prior weight into\n');
  process.stdout.write('the signature scorer. No gain / worse = frequency is not a useful prior at this data size.\n');
  process.stdout.write('(legacy note) closed-set WARM well above chance = discriminative text signal EXISTS.\n');
}

main().catch((e) => { process.stderr.write(`signature-probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
