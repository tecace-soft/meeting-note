import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { HttpError, getBearerToken, requiredString, readBody, sendJson, corsHeaders } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { callGeminiWithFallback } from '../ai/geminiFallback.js';
import { PROJECT_CHAT_MODEL, GEMINI_2_5_FLASH_LITE, STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { noteAccessFilterFor } from '../mcp/lib/supabase.js';

interface ProjectChatRequest {
  message?: unknown;
  project_id?: unknown;
}

export function parseProjectChatInput(body: ProjectChatRequest): { message: string; projectId: string; projectIdFilterValue: string | number } {
  const message = requiredString(body, 'message');
  const rawProjectId = body.project_id;
  const projectId =
    typeof rawProjectId === 'string' || typeof rawProjectId === 'number'
      ? String(rawProjectId).trim()
      : '';
  if (!projectId) throw new HttpError(400, 'project_id is required.');
  const asNumber = Number(projectId);
  return {
    message,
    projectId,
    projectIdFilterValue: Number.isNaN(asNumber) ? projectId : asNumber,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function noteText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function projectChatContext(notes: Array<Record<string, unknown>>): string {
  return notes.map((note, index) => {
    const n = index + 1;
    const transcription = noteText(note, 'transcription');
    const summary = noteText(note, 'summary');
    return `transcription${n}:\n${transcription}\n\nsummary${n}:\n${summary}\n\n`;
  }).join('\n\n');
}

function buildProjectChatPrompt(context: string, message: string): string {
  return `You are an internal AI assistant for TecAce Software, Ltd. Your primary role is to answer user questions accurately, concisely, and professionally, based EXCLUSIVELY on the provided company meeting transcriptions and the summaries of those transcriptions.

### CORE DIRECTIVES
1. **Strict Grounding:** You must base your answers ONLY on the context provided in the prompt (the transcripts, summaries, and associated metadata). Under no circumstances should you use outside knowledge, speculate, guess, or hallucinate information. First check the summaries for your answers. If unable to generate a response based on summary information alone start digging deeper into the transcription itself to see if more information can be found there.
2. **Handling Missing Information:** If the provided context does not contain the answer to the user's question, you must clearly state: "I cannot find the answer to that in the provided meeting documents." Do not attempt to infer an answer if the data is missing.
3. **Cite Sources:** Whenever possible, reference the specific meeting date, title, or speaker associated with the information to build trust (e.g., "During the Q3 All-Hands on October 12th, Jane Doe stated...").
4. **Maintain Objectivity:** Present the information exactly as it was discussed. Do not inject personal opinions, bias, or commentary on the meeting's contents.

### RESPONSE GUIDELINES
- **Clarity & Brevity:** Keep your answers direct and easy to read. Use bullet points when summarizing multiple topics, listing action items, or detailing decisions.
- **Direct Quotes:** If a user asks exactly what a specific person said, or if the exact phrasing is highly important, provide a brief direct quote from the transcript enclosed in quotation marks.
- **Action Items & Decisions:** If asked about next steps or outcomes, clearly identify what was decided, who is responsible, and any stated deadlines—provided that information exists in the text.
- **Ambiguity:** If the meeting text is ambiguous, speakers are unclear, or multiple meetings have conflicting information, point out this discrepancy to the user rather than guessing the "correct" interpretation.

### TRANSCRIPTION AND SUMMARIES
${context}

### USER QUESTION
${message}`;
}

async function projectChatPromptFromRequest(req: IncomingMessage): Promise<string> {
  const tokenUserId = await getMicrosoftUserId(getBearerToken(req));
  const input = parseProjectChatInput((await readBody(req)) as ProjectChatRequest);

  let { data: projectRow, error: projectError } = await supabase
    .from('project')
    .select('id,user_id,shared_users')
    .eq('id', input.projectId)
    .maybeSingle();
  if (!projectRow && !projectError && input.projectIdFilterValue !== input.projectId) {
    const fallback = await supabase
      .from('project')
      .select('id,user_id,shared_users')
      .eq('id', input.projectIdFilterValue)
      .maybeSingle();
    projectRow = fallback.data;
    projectError = fallback.error;
  }
  if (projectError) throw projectError;
  if (!projectRow) {
    throw new HttpError(404, 'Project not found.');
  }

  const project = projectRow as Record<string, unknown>;
  const sharedUsers = stringArray(project.shared_users);
  const hasProjectAccess = project.user_id === tokenUserId || sharedUsers.includes(tokenUserId);
  if (!hasProjectAccess) {
    throw new HttpError(403, 'You do not have access to this project.');
  }

  // Project access alone is NOT note access. Project chat runs as service_role
  // (RLS bypassed), so restrict the fed notes to ones this caller may actually
  // see, reusing the exact per-note visibility rule the MCP path enforces (own,
  // directly shared, or owned by a project owner who shared the project with the
  // caller). Without this, a third party's note merely attached to the project
  // would leak its transcript/summary into the answer.
  const accessFilter = await noteAccessFilterFor(supabase, tokenUserId);
  let noteQuery = supabase
    .from('note')
    .select('transcription,summary')
    .contains('projects', [input.projectIdFilterValue]);
  if (accessFilter) noteQuery = noteQuery.or(accessFilter);
  const { data: noteRows, error: noteError } = await noteQuery;
  if (noteError) throw noteError;
  const notes = (noteRows ?? []) as Array<Record<string, unknown>>;
  if (notes.length === 0) {
    return 'I cannot find the answer to that in the provided meeting documents.';
  }
  return buildProjectChatPrompt(projectChatContext(notes), input.message);
}

async function projectChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const prompt = await projectChatPromptFromRequest(req);
  if (prompt === 'I cannot find the answer to that in the provided meeting documents.') {
    sendJson(res, 200, { response: prompt });
    return;
  }
  const result = await callGeminiWithFallback({
    stage: 'Project chat',
    model: PROJECT_CHAT_MODEL,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'text/plain',
    maxOutputTokens: 4096,
    parts: [{ text: prompt }],
  });
  sendJson(res, 200, { response: result.text.trim() });
}

export function projectChatDelta(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';
  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

async function streamProjectChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const prompt = await projectChatPromptFromRequest(req);
  const openStream = () => {
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
  };
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (prompt === 'I cannot find the answer to that in the provided meeting documents.') {
    openStream();
    send({ delta: prompt });
    send({ done: true });
    res.end();
    return;
  }

  // Unique ordering for project chat (primary PROJECT_CHAT_MODEL first); kept
  // inline but built from the registry consts to preserve this failover order.
  const models = [PROJECT_CHAT_MODEL, GEMINI_2_5_FLASH_LITE];
  let response: Response | null = null;
  let lastError = '';
  for (const model of models) {
    const candidate = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: 'text/plain',
          },
        }),
      },
    );
    if (candidate.ok && candidate.body) {
      response = candidate;
      break;
    }
    lastError = `Gemini stream failed (${candidate.status}): ${(await candidate.text()).slice(0, 500)}`;
  }
  if (!response || !response.body) {
    throw new Error(lastError || 'Gemini stream failed.');
  }

  openStream();
  send({ delta: '' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice('data:'.length).trim();
        if (!raw || raw === '[DONE]') continue;
        const delta = projectChatDelta(JSON.parse(raw));
        if (delta) send({ delta });
      }
    }
  }
  send({ done: true });
  res.end();
}

export async function handleProjectChatRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'POST' && req.url === '/project-chat') { await projectChat(req, res); return true; }
  if (req.method === 'POST' && req.url === '/project-chat/stream') { await streamProjectChat(req, res); return true; }
  return false;
}
