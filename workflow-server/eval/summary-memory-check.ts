// E2E-ish diagnostic for the F1' -> summary injection: generate a real note's summary
// TWICE (roster of context identical, personal memory OFF vs ON) and print both, so a
// human can judge (a) does the memory make the summary connect to ongoing work, and
// (b) does it DRIFT — inject any fact/person/number not in the transcript.
//
// Uses the REAL summary prompt (buildSummaryPrompt) + the real JSON model path
// (callJsonModel), the owner's real prod memory, and a real note's transcript. Read-only.
// Run: `npm run eval:summary-mem -- <noteId>`  (defaults to a known Andrew note).

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildSummaryPrompt } from '../src/prompts.js';
import { callJsonModel, renderMemoryForContext } from '../src/memory.js';

config();

const DEFAULT_NOTE = '7f20f70c-9289-4d93-b5f3-5bcff4dc35d8'; // 2026-08-12, Andrew-owned, rich
const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash-lite';
// A fixed, generic ruleset so the ONLY variable between the two runs is personal memory.
const SUMMARY_RULES = 'Write structured, actionable meeting notes in markdown: a short overview, key decisions, action items (with owner when stated), and open questions.';

interface Seg { speaker?: string; original?: string; text?: string; translated?: string }

function segText(s: Seg): string {
  return (s.original ?? s.text ?? s.translated ?? '').trim();
}

interface Parsed { title: string; summary: string; tags: string[] }
function parseSummary(text: string): Parsed | null {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const o = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof o.summary !== 'string') return null;
    return { title: String(o.title ?? ''), summary: o.summary, tags: Array.isArray(o.tags) ? o.tags.map(String) : [] };
  } catch {
    return null;
  }
}

async function generate(apiKey: string, prompt: string): Promise<Parsed | null> {
  const res = await callJsonModel<Parsed>({
    apiKey,
    models: [SUMMARY_MODEL, 'gemini-3.1-flash-lite'],
    systemPrompt: '',
    userPrompt: prompt,
    parse: parseSummary,
    maxOutputTokens: 16384,
  });
  return 'error' in res ? null : res.value;
}

async function main(): Promise<void> {
  const noteId = process.argv[2] || DEFAULT_NOTE;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) {
    process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: note, error: noteErr } = await db
    .from('note')
    .select('user_id, name, diarization, transcription, transcription_language, meeting_at')
    .eq('id', noteId)
    .maybeSingle();
  if (noteErr || !note) {
    process.stderr.write(`Note ${noteId} not found${noteErr ? `: ${noteErr.message}` : ''}.\n`);
    process.exit(1);
  }
  const userId = (note as { user_id: string }).user_id;
  const segs = Array.isArray((note as { diarization?: Seg[] }).diarization) ? (note as { diarization: Seg[] }).diarization : [];
  const transcript = (segs.length
    ? segs.map((s) => `${s.speaker ?? 'Speaker'}: ${segText(s)}`).join('\n')
    : String((note as { transcription?: unknown }).transcription ?? '')).trim();
  const outputLanguage: 'en' | 'ko' = (note as { transcription_language?: string }).transcription_language === 'en' ? 'en' : 'ko';

  const { data: mem } = await db.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
  const memoryText = renderMemoryForContext((mem as { memory?: unknown } | null)?.memory ?? null);

  process.stdout.write(`\nNOTE ${noteId}  owner=${userId}  lang=${outputLanguage}  transcript=${transcript.length} chars\n`);
  process.stdout.write(`PERSONAL MEMORY: ${memoryText ? `${memoryText.length} chars, ${memoryText.split('\n').length} items` : 'EMPTY'}\n`);
  if (!memoryText) {
    process.stdout.write('No memory to inject — the two runs would be identical. Pick a note whose owner has memory.\n');
    process.exit(0);
  }

  const common = { now: new Date().toISOString(), meetingDate: (note as { meeting_at?: string }).meeting_at ?? null, summaryRules: SUMMARY_RULES, fileName: (note as { name?: string }).name ?? 'note', transcript, outputLanguage };
  const promptOff = buildSummaryPrompt(common);
  const promptOn = buildSummaryPrompt({ ...common, personalMemoryContext: memoryText });

  process.stdout.write('\nGenerating (memory OFF)…\n');
  const off = await generate(apiKey, promptOff);
  process.stdout.write('Generating (memory ON)…\n');
  const on = await generate(apiKey, promptOn);

  process.stdout.write('\n════════ INJECTED PERSONAL MEMORY ════════\n' + memoryText + '\n');
  process.stdout.write('\n════════ SUMMARY — MEMORY OFF (baseline) ════════\n');
  process.stdout.write(off ? `# ${off.title}\n${off.summary}\n` : '(generation failed)\n');
  process.stdout.write('\n════════ SUMMARY — MEMORY ON ════════\n');
  process.stdout.write(on ? `# ${on.title}\n${on.summary}\n` : '(generation failed)\n');
  process.stdout.write('\n════════ REVIEW CHECKLIST ════════\n');
  process.stdout.write('1. Does MEMORY ON connect this meeting to ongoing work the transcript alone would not show?\n');
  process.stdout.write('2. DRIFT: does MEMORY ON assert any person / number / decision / action NOT in the transcript? (must be none)\n');
}

main().catch((error) => {
  process.stderr.write(`summary-mem failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
