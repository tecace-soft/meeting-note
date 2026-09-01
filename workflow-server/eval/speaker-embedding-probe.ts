// H1 EMBEDDING SIGNATURE PROBE (read-only) — does a MEANING vector beat the TF-IDF ceiling?
//
// The shipped signature identifier matches an anonymous label to the nearest per-speaker TF-IDF
// bag-of-words signature; its measured warm ceiling is ~82% (eval:speaker-signature). TF-IDF needs
// EXACT word overlap ("배포" vs "deploy", "레이턴시" vs "지연" score 0 despite same meaning). H1
// replaces the word-count vector with a semantic EMBEDDING (gemini-embedding-001), which places
// synonyms / paraphrases / cross-lingual restatements close. This probe measures whether that
// actually beats TF-IDF on the SAME cases, BEFORE building any embedding cache/store.
//
// Method (identical case set + leave-one-out to eval:speaker-signature, so the arms are comparable):
//   - Each (person, note) utterance blob is embedded ONCE. That vector is BOTH the label's query
//     vector (a label's text == its true speaker's blob in that note) AND a component of every
//     OTHER note's signature — so no extra calls for queries.
//   - A candidate's leave-one-out signature for target note T = mean-pool of their per-note vectors
//     EXCLUDING T (the meeting being scored is never in the signature). cosine match.
//   - TF-IDF arm = the SHIPPED matchLabel (speakerSignature.ts), scored on the same labels.
//   - Report closed-set / open-set / warm accuracy for both arms + the delta.
//
// gemini-embedding-001 is an EMBEDDING model (NOT a generation model), so it is OUTSIDE the team's
// lite-only generation cost cap; a probe embeds a few hundred short blobs = a few cents, no infra.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY. Read-only (reads note.diarization).
// Run: `npm run eval:speaker-embed`.
// Tunables (env): EMB_USERS (csv or "all"), EMB_NOTES_PER_USER (30), EMB_MIN_NAMED (2),
//   EMB_SCAN_LIMIT (300), EMB_MAX_EMBEDS (hard cap on API calls, 400), EMB_DIM (1536), EMB_MODEL.

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { canonName, buildCorpora, computeIdf, matchLabel, type LabeledUtterance } from '../src/speakerSignature.js';

config();

const NOTES_PER_USER = clampInt(process.env.EMB_NOTES_PER_USER, 30, 2, 100);
const MIN_NAMED = clampInt(process.env.EMB_MIN_NAMED, 2, 1, 10);
const SCAN_LIMIT = clampInt(process.env.EMB_SCAN_LIMIT, 300, 50, 5000);
const MAX_EMBEDS = clampInt(process.env.EMB_MAX_EMBEDS, 400, 10, 4000);
const DIM = clampInt(process.env.EMB_DIM, 1536, 256, 3072);
const MODEL = (process.env.EMB_MODEL || 'gemini-embedding-001').trim();
const MAX_CHARS = 8000; // ~2k tokens; embedding models cap input length

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }

const isAnonName = (s: string): boolean => /^speaker\s/i.test(s.trim()) || s.trim() === '' || /^unknown/i.test(s.trim());

interface LabelInstance { noteId: string; trueKey: string | null; trueRaw: string | null; text: string }
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

// ---- embedding ----
const embedCache = new Map<string, number[] | null>();
let embedCalls = 0;

async function embed(apiKey: string, text: string): Promise<number[] | null> {
  const clipped = text.slice(0, MAX_CHARS);
  const cached = embedCache.get(clipped);
  if (cached !== undefined) return cached;
  if (embedCalls >= MAX_EMBEDS) return null; // hard cost bound (Power of Ten rule 2)
  embedCalls += 1;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${apiKey}`;
  const body = { content: { parts: [{ text: clipped }] }, taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: DIM };
  let vec: number[] | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j = (await res.json()) as { embedding?: { values?: number[] } };
      const vals = j?.embedding?.values;
      if (Array.isArray(vals) && vals.length) vec = vals;
    } else if (res.status === 429 || res.status >= 500) {
      process.stderr.write(`  embed ${res.status} (rate/again) — arm will thin out\n`);
    }
  } catch (_e) { /* leave vec null; the label is skipped in both arms for fairness */ }
  embedCache.set(clipped, vec);
  return vec;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function meanPool(vecs: number[][]): number[] | null {
  if (vecs.length === 0) return null;
  const n = vecs[0].length;
  const out = new Array<number>(n).fill(0);
  for (const v of vecs) for (let i = 0; i < n; i += 1) out[i] += v[i];
  for (let i = 0; i < n; i += 1) out[i] /= vecs.length;
  return out;
}

interface Tally { total: number; correct: number }
const add = (t: Tally, ok: boolean) => { t.total += 1; if (ok) t.correct += 1; };
const pctOf = (t: Tally): string => (t.total ? `${((t.correct / t.total) * 100).toFixed(1)}%` : '  -  ');

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!url || !key) { process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.\n'); process.exit(1); }
  if (!apiKey) { process.stderr.write('GEMINI_API_KEY (or GOOGLE_API_KEY) required for embeddings.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const arg = (process.env.EMB_USERS || 'all').trim();
  const users = arg && arg !== 'all' ? arg.split(',').map((u) => u.trim()).filter(Boolean) : await discoverUsers(db);

  process.stdout.write(`\nH1 EMBEDDING SIGNATURE PROBE — TF-IDF (shipped) vs ${MODEL} (dim=${DIM})\n`);
  process.stdout.write(`users=${users.length}  notes/user<=${NOTES_PER_USER}  max-embeds=${MAX_EMBEDS}\n\n`);

  type ArmTally = { closed: Tally; closedWarm: Tally; open: Tally; openWarm: Tally };
  const mk = (): ArmTally => ({ closed: { total: 0, correct: 0 }, closedWarm: { total: 0, correct: 0 }, open: { total: 0, correct: 0 }, openWarm: { total: 0, correct: 0 } });
  const tfidf = mk();
  const emb = mk();
  let scored = 0, chance = 0, chanceN = 0;

  for (const userId of users) {
    if (embedCalls >= MAX_EMBEDS) { process.stdout.write(`• skip ${userId.slice(0, 8)}… (embed cap reached)\n`); continue; }
    const notes = await loadUserNotes(db, userId);
    const cases: NoteCase[] = [];
    const utt: LabeledUtterance[] = [];
    // Embedding corpus: canonKey -> [{noteId, vec}] (each (person,note) blob embedded once).
    const embCorpus = new Map<string, Array<{ noteId: string; vec: number[] }>>();
    // Query vector lookup: `${noteId}|${key}` -> vec (reuse the same per-note embedding as the query).
    const queryVec = new Map<string, number[]>();

    for (const n of notes) {
      const labels = toLabels(n);
      if (!labels) continue;
      for (const l of labels) {
        if (!l.trueKey || !l.trueRaw) continue;
        utt.push({ noteId: l.noteId, name: l.trueRaw, text: l.text });
        const v = await embed(apiKey, l.text);
        if (v) {
          (embCorpus.get(l.trueKey) ?? embCorpus.set(l.trueKey, []).get(l.trueKey)!).push({ noteId: l.noteId, vec: v });
          queryVec.set(`${l.noteId}|${l.trueKey}`, v);
        }
      }
      const participantKeys = [...new Set(labels.filter((l) => l.trueKey).map((l) => l.trueKey as string))];
      if (participantKeys.length >= MIN_NAMED) cases.push({ noteId: n.id, labels, participantKeys });
    }
    const corpora = buildCorpora(utt);
    const idf = computeIdf(corpora);
    const roster = [...corpora.keys()];
    if (roster.length < 2 || cases.length === 0) continue;

    // Embedding leave-one-out signature (mean-pool of a person's OTHER-note vectors).
    const embSig = (personKey: string, excludeNoteId: string): number[] | null =>
      meanPool((embCorpus.get(personKey) ?? []).filter((d) => d.noteId !== excludeNoteId).map((d) => d.vec));
    const embWarm = (personKey: string, excludeNoteId: string): boolean =>
      (embCorpus.get(personKey) ?? []).some((d) => d.noteId !== excludeNoteId);
    const embBest = (qv: number[], candidates: string[], excludeNoteId: string): string | null => {
      let best: string | null = null, bestScore = -Infinity;
      for (const cand of candidates) {
        const sig = embSig(cand, excludeNoteId);
        if (!sig) continue;
        const sc = cosine(qv, sig);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      return best;
    };
    // TF-IDF (shipped) best-of within a candidate set.
    const tfBest = (text: string, candidates: string[], excludeNoteId: string): string | null => {
      const cset = new Set(candidates);
      const ranked = matchLabel(text, corpora, idf, excludeNoteId).filter((m) => cset.has(m.personKey));
      return ranked.length ? ranked[0].personKey : null;
    };

    for (const c of cases) {
      for (const l of c.labels) {
        if (!l.trueKey) continue;
        const qv = queryVec.get(`${c.noteId}|${l.trueKey}`);
        if (!qv) continue; // no embedding for this label (cap/failure) — skip in BOTH arms for fairness
        scored += 1;
        chance += 1 / Math.max(1, c.participantKeys.length); chanceN += 1;
        const warm = embWarm(l.trueKey, c.noteId);

        // TF-IDF arm
        const tClosed = tfBest(l.text, c.participantKeys, c.noteId) === l.trueKey;
        add(tfidf.closed, tClosed); if (warm) add(tfidf.closedWarm, tClosed);
        const tOpen = tfBest(l.text, roster, c.noteId) === l.trueKey;
        add(tfidf.open, tOpen); if (warm) add(tfidf.openWarm, tOpen);

        // Embedding arm
        const eClosed = embBest(qv, c.participantKeys, c.noteId) === l.trueKey;
        add(emb.closed, eClosed); if (warm) add(emb.closedWarm, eClosed);
        const eOpen = embBest(qv, roster, c.noteId) === l.trueKey;
        add(emb.open, eOpen); if (warm) add(emb.openWarm, eOpen);
      }
    }
    process.stdout.write(`• ${userId.slice(0, 8)}…  roster=${roster.length}  cases=${cases.length}  embeds=${embedCalls}\n`);
  }

  const line = (tag: string, t: ArmTally) =>
    `${tag.padEnd(7)} ${pctOf(t.closed).padStart(6)}(${String(t.closed.total).padStart(3)})   ` +
    `${pctOf(t.closedWarm).padStart(6)}(${String(t.closedWarm.total).padStart(3)})   ` +
    `${pctOf(t.open).padStart(6)}(${String(t.open.total).padStart(3)})   ` +
    `${pctOf(t.openWarm).padStart(6)}(${String(t.openWarm.total).padStart(3)})\n`;

  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write(`SIGNATURE-MATCH ACCURACY (same cases) — labels scored=${scored}, embed calls=${embedCalls}\n`);
  process.stdout.write(`  random-within-set chance: ${(chanceN ? (chance / chanceN) * 100 : 0).toFixed(1)}%   TF-IDF warm ceiling (ref): ~82%\n\n`);
  process.stdout.write('arm     closed-set      closed-WARM     open-set        open-WARM\n');
  process.stdout.write(line('tfidf', tfidf));
  process.stdout.write(line('embed', emb));
  const d = (a: Tally, b: Tally) => (a.total && b.total ? `${(((b.correct / b.total) - (a.correct / a.total)) * 100).toFixed(1)}pt` : '  -');
  process.stdout.write(`delta   ${d(tfidf.closed, emb.closed).padStart(6)}         ${d(tfidf.closedWarm, emb.closedWarm).padStart(6)}         ${d(tfidf.open, emb.open).padStart(6)}         ${d(tfidf.openWarm, emb.openWarm).padStart(6)}\n`);
  process.stdout.write('\nRead: embed open-WARM > tfidf open-WARM by a clear margin = embeddings beat the TF-IDF ceiling,\n');
  process.stdout.write('worth building the cached embedding store. ~0 or negative = TF-IDF is enough; do not build it.\n');
}

main().catch((e) => { process.stderr.write(`embedding-probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
