// Faithful reproduction of the generate-profile "Sync Profile" call for the HEAVIEST speaker
// (read-only). The user hit `Gemini call exceeded 30000ms and was aborted` for "Andrew Yoo (유영준)".
//
// This rebuilds the EXACT edge-fn request (same model, generationConfig, nested ONTOLOGY_SCHEMA,
// and update prompt with the speaker's real existing profile + a real transcript), then times the
// Gemini call WITH the nested responseSchema vs WITHOUT it (the schema-less identify/diarize twin
// that never hangs). Goal: isolate whether the nested schema is the latency/hang trigger.
//
// Read-only (never writes the speaker row). Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
// GEMINI_API_KEY. Run: `npx tsx scripts/probe-generate-profile.ts`.
//
// Tunables (env):
//   PROBE_USER      user_id to probe (default 31d79bfe… Andrew)
//   PROBE_SPEAKER   speaker display name to profile (default: the user's self / heaviest row)
//   PROBE_RUNS      timed runs per variant (default 3)
//   PROBE_MODEL     model (default gemini-3.1-flash-lite)
//   PROBE_TIMEOUT   per-call abort ms (default 60000 — deliberately > the prod 30000 so we can
//                   SEE how long a hung/slow call actually takes instead of clipping at 30s)

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

config();

const USER = (process.env.PROBE_USER || '31d79bfe').trim();
const RUNS = Math.max(1, Math.min(6, Number(process.env.PROBE_RUNS) || 3));
const MODEL = (process.env.PROBE_MODEL || 'gemini-3.1-flash-lite').trim();
const TIMEOUT_MS = Math.max(5_000, Number(process.env.PROBE_TIMEOUT) || 60_000);
const MAX_ARRAY_ITEMS = 4;
const MAX_STR_LEN = 120;
const MAX_TRANSCRIPT_CHARS = 150_000;

// ---- exact ONTOLOGY_SCHEMA from the edge fn ----
const CONF = { type: 'NUMBER' } as const;
const STR = { type: 'STRING', maxLength: MAX_STR_LEN } as const;
const STR_ARRAY = { type: 'ARRAY', maxItems: MAX_ARRAY_ITEMS, items: { type: 'STRING', maxLength: MAX_STR_LEN } } as const;
const ONTOLOGY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    schema_version: STR,
    speaker_id: STR,
    display_name: STR,
    aliases: STR_ARRAY,
    identity_confidence: CONF,
    professional_context: {
      type: 'OBJECT',
      properties: { company: STR, role: STR, domains: STR_ARRAY, confidence: CONF },
    },
    active_projects: {
      type: 'ARRAY', maxItems: MAX_ARRAY_ITEMS,
      items: { type: 'OBJECT', properties: { name: STR, role_in_project: STR, status: STR, importance: STR, confidence: CONF } },
    },
    relationships: {
      type: 'ARRAY', maxItems: MAX_ARRAY_ITEMS,
      items: { type: 'OBJECT', properties: { person_or_group: STR, relationship_type: STR, context: STR, related_projects: STR_ARRAY, confidence: CONF } },
    },
    responsibilities: {
      type: 'ARRAY', maxItems: MAX_ARRAY_ITEMS,
      items: { type: 'OBJECT', properties: { description: STR, scope: STR, related_projects: STR_ARRAY, status: STR, confidence: CONF } },
    },
    open_threads: {
      type: 'ARRAY', maxItems: MAX_ARRAY_ITEMS,
      items: { type: 'OBJECT', properties: { topic: STR, status: STR, priority: STR, summary: STR, related_projects: STR_ARRAY, confidence: CONF } },
    },
    last_updated_at: STR,
  },
  required: ['schema_version', 'speaker_id', 'display_name', 'professional_context', 'active_projects', 'relationships', 'responsibilities', 'open_threads', 'last_updated_at'],
} as const;

const UPDATE_SYSTEM = 'You are a speaker ontology update engine for a meeting note application. Update an existing lightweight speaker ontology using a new diarized transcript. Be terse: every string field <=120 chars, each array <=6 items, never pad or invent. Output ONLY the required keys; never output summary_for_meeting_context.';

function buildUpdatePrompt(name: string, speakerId: string, existing: string, transcript: string, date: string): string {
  return `Update the existing ontology for ${name} using the new transcript below.\n\nRules:\n- Keep existing info unless the new transcript clearly updates it.\n- Do not duplicate items; merge similar ones.\n- Be BRIEF: at most 3 items per array, every string <=80 chars.\n- Output valid JSON only. Output ONLY the required keys.\n- Update last_updated_at to "${date}".\n\nExisting ontology:\n${existing}\n\nNew transcript:\n${transcript}`;
}

interface Seg { speaker?: unknown; text?: unknown }
interface NoteRow { id: string; created_at: string; diarization: unknown }

async function resolveUser(db: SupabaseClient): Promise<string> {
  if (USER.length >= 30) return USER;
  const { data } = await db.from('speaker').select('user_id, name').ilike('user_id', `${USER}%`).limit(1);
  const u = (data ?? [])[0] as { user_id?: string } | undefined;
  if (!u?.user_id) throw new Error(`No speaker row for user prefix ${USER}`);
  return u.user_id;
}

async function pickSpeaker(db: SupabaseClient, userId: string): Promise<{ id: string; name: string; profile: string }> {
  const wanted = process.env.PROBE_SPEAKER?.trim();
  const { data } = await db.from('speaker').select('id, name, profile').eq('user_id', userId);
  const rows = ((data ?? []) as Array<{ id: string | number; name: string; profile: string | null }>).filter((r) => r.name);
  if (rows.length === 0) throw new Error('No speaker rows for this user.');
  if (wanted) {
    const hit = rows.find((r) => r.name === wanted) ?? rows.find((r) => r.name.includes(wanted));
    if (hit) return { id: String(hit.id), name: hit.name, profile: hit.profile ?? '' };
  }
  // default: heaviest profile (longest string = biggest UPDATE input/output)
  rows.sort((a, b) => (b.profile?.length ?? 0) - (a.profile?.length ?? 0));
  return { id: String(rows[0].id), name: rows[0].name, profile: rows[0].profile ?? '' };
}

async function buildTranscript(db: SupabaseClient, userId: string, speakerName: string): Promise<string> {
  const { data } = await db.from('note').select('id, created_at, diarization')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(60);
  const rows = (data ?? []) as NoteRow[];
  // pick the most recent note in which this speaker actually has lines (mirrors the real flow).
  for (const r of rows) {
    const segs = Array.isArray(r.diarization) ? (r.diarization as Seg[]) : [];
    const has = segs.some((s) => typeof s.speaker === 'string' && (s.speaker as string).trim() === speakerName && typeof s.text === 'string');
    if (!has) continue;
    const text = segs.filter((s) => typeof s.text === 'string' && (s.text as string).trim())
      .map((s) => `${typeof s.speaker === 'string' ? s.speaker : 'Speaker'}: ${s.text as string}`).join('\n\n');
    if (text.trim()) return text.slice(0, MAX_TRANSCRIPT_CHARS);
  }
  throw new Error(`No recent note with lines for "${speakerName}".`);
}

async function timedGeminiCall(apiKey: string, userPrompt: string, useSchema: boolean): Promise<{ ms: number; ok: boolean; finishReason?: string; len: number; timedOut: boolean; err?: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: 24576,
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (useSchema) generationConfig.responseSchema = ONTOLOGY_SCHEMA;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: UPDATE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig,
      }),
    });
    const ms = Date.now() - start;
    clearTimeout(timer);
    const bodyText = await res.text();
    let data: { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; error?: { message?: string } };
    try { data = JSON.parse(bodyText); } catch { return { ms, ok: false, len: bodyText.length, timedOut: false, err: `unparseable HTTP ${res.status}` }; }
    if (!res.ok || data.error) return { ms, ok: false, len: bodyText.length, timedOut: false, err: `HTTP ${res.status}: ${data.error?.message ?? bodyText.slice(0, 120)}` };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const raw = parts.map((p) => p.text ?? '').join('').trim();
    let parses = false;
    try { JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); parses = true; } catch { /* no */ }
    return { ms, ok: parses, finishReason: data.candidates?.[0]?.finishReason, len: raw.length, timedOut: false };
  } catch (e) {
    const ms = Date.now() - start;
    clearTimeout(timer);
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return { ms, ok: false, len: 0, timedOut, err: timedOut ? `ABORTED at ${TIMEOUT_MS}ms` : String(e) };
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY required.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const userId = await resolveUser(db);
  const speaker = await pickSpeaker(db, userId);
  const transcript = await buildTranscript(db, userId, speaker.name);
  const date = '2026-08-26T00:00:00.000Z';
  const userPrompt = buildUpdatePrompt(speaker.name, speaker.id, speaker.profile || '{}', transcript, date);

  process.stdout.write(`\nPROBE generate-profile  model=${MODEL}  per-call-timeout=${TIMEOUT_MS}ms  runs=${RUNS}\n`);
  process.stdout.write(`user=${userId.slice(0, 8)}…  speaker="${speaker.name}"  profileChars=${speaker.profile.length}  transcriptChars=${transcript.length}  promptChars=${userPrompt.length}\n\n`);

  for (const useSchema of [true, false]) {
    process.stdout.write(`── ${useSchema ? 'WITH nested responseSchema (prod)' : 'WITHOUT schema (identify-twin style)'} ──\n`);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const r = await timedGeminiCall(apiKey, userPrompt, useSchema);
      times.push(r.ms);
      const flag = r.timedOut ? 'TIMED-OUT' : r.ok ? 'ok' : 'FAIL';
      process.stdout.write(`  run ${i + 1}: ${String(r.ms).padStart(6)}ms  ${flag.padEnd(9)} outLen=${String(r.len).padStart(6)} finish=${r.finishReason ?? '-'}${r.err ? '  ' + r.err : ''}\n`);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const over30 = times.filter((t) => t >= 30_000).length;
    process.stdout.write(`  median=${med}ms  max=${Math.max(...times)}ms  runs>=30s(prod abort)=${over30}/${RUNS}\n\n`);
  }

  process.stdout.write('Read: if WITH-schema runs are slow / hit the 30s prod abort while WITHOUT-schema stays fast,\nthe nested responseSchema is the hang trigger (matches the identify/diarize twin dropping its schema).\n');
}

main().catch((e) => { process.stderr.write(`probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
