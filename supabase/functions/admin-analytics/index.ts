import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token',
};

const ADMIN_MICROSOFT_USER_IDS = new Set([
  'd84c9149-2261-4ced-b14c-01b1a377ba6b',
  'd9eb0f3d-819e-4b45-8df6-e9f229de2447',
]);

type RangeKey = 'all' | '7d' | '30d' | '90d';

interface RequestBody {
  range?: RangeKey;
  chartStartDate?: string;
  chartEndDate?: string;
}

interface UsageDay {
  date: string;
  notes: number;
  aiTokens: number;
  aiEstimatedCostUsd: number;
  transcriptionLatencyMs: number;
  transcriptionLatencySamples: number;
  summaryLatencyMs: number;
  summaryLatencySamples: number;
  total: number;
}

interface AppUserRow {
  microsoft_id: string;
  display_name: string | null;
  email: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string | null;
}

interface NoteRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  created_at: string | null;
  summary: string | null;
  summary_edit: string | null;
  transcription: string | null;
  diarization: unknown;
  shared_users: unknown;
}

interface FileRow {
  id: string;
  user_id: string | null;
  source: string | null;
  size_bytes: number | null;
  created_at: string | null;
}

interface ProjectRow {
  id: string;
  user_id: string | null;
  created_at: string | null;
}

interface PromptRow {
  id: string;
  user_id: string | null;
  created_at: string | null;
}

interface TokenRow {
  id: string;
  user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

interface SpeakerRow {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  microsoft_id: string | null;
  profile: string | null;
  created_at: string | null;
}

interface WorkflowUsageRow {
  user_id: string | null;
  stage: string | null;
  provider: string | null;
  prompt_tokens: number | null;
  candidates_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  estimated_cost_usd: number | string | null;
  created_at: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function getMicrosoftUserId(accessToken: string): Promise<{ userId: string | null; error?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      userId: null,
      error: `Microsoft Graph /me rejected the token (${response.status}). ${detail.slice(0, 300)}`,
    };
  }
  const data = (await response.json()) as { id?: unknown };
  return {
    userId: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null,
    error: 'Microsoft Graph /me did not return a user id.',
  };
}

function sinceForRange(range: RangeKey): string | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addUtcDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getChartWindow(chartStartDate: unknown, chartEndDate: unknown): {
  startDate: string;
  endDate: string;
  startIso: string;
  endExclusiveIso: string;
  days: string[];
} {
  const endDate = isDateKey(chartEndDate) ? chartEndDate : new Date().toISOString().slice(0, 10);
  let startDate = isDateKey(chartStartDate) ? chartStartDate : addUtcDays(endDate, -6);
  if (startDate > endDate) {
    startDate = addUtcDays(endDate, -6);
  }

  const days: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate && days.length < 90) {
    days.push(cursor);
    cursor = addUtcDays(cursor, 1);
  }

  const endExclusiveDate = addUtcDays(endDate, 1);
  return {
    startDate,
    endDate,
    startIso: `${startDate}T00:00:00.000Z`,
    endExclusiveIso: `${endExclusiveDate}T00:00:00.000Z`,
    days,
  };
}

function dateKeyFromTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function createUsageDays(days: string[]): Map<string, UsageDay> {
  return new Map(
    days.map((date) => [
      date,
      {
        date,
        notes: 0,
        aiTokens: 0,
        aiEstimatedCostUsd: 0,
        transcriptionLatencyMs: 0,
        transcriptionLatencySamples: 0,
        summaryLatencyMs: 0,
        summaryLatencySamples: 0,
        total: 0,
      },
    ])
  );
}

function asFiniteNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function addNoteUsageRows(rows: Array<{ created_at: string | null }>, usageByDate: Map<string, UsageDay>): void {
  for (const row of rows) {
    const dateKey = dateKeyFromTimestamp(row.created_at);
    const day = dateKey ? usageByDate.get(dateKey) : undefined;
    if (!day) continue;
    day.notes += 1;
    day.total += 1;
  }
}

function addWorkflowUsageRows(rows: WorkflowUsageRow[], usageByDate: Map<string, UsageDay>): void {
  for (const row of rows) {
    const dateKey = dateKeyFromTimestamp(row.created_at);
    const day = dateKey ? usageByDate.get(dateKey) : undefined;
    if (!day) continue;

    if (row.stage === 'summarization' && row.provider === 'google-gemini') {
      day.aiTokens += asFiniteNumber(row.total_tokens);
    }
    day.aiEstimatedCostUsd += asFiniteNumber(row.estimated_cost_usd);

    const latencyMs = asFiniteNumber(row.latency_ms);
    if (latencyMs <= 0) continue;
    if (row.stage === 'transcription' && row.provider === 'assemblyai') {
      day.transcriptionLatencyMs += latencyMs;
      day.transcriptionLatencySamples += 1;
    } else if (row.stage === 'summarization' && row.provider === 'google-gemini') {
      day.summaryLatencyMs += latencyMs;
      day.summaryLatencySamples += 1;
    }
  }
}

function finalizeUsageDay(day: UsageDay): UsageDay {
  return {
    ...day,
    aiEstimatedCostUsd: Number(day.aiEstimatedCostUsd.toFixed(6)),
    transcriptionLatencyMs: day.transcriptionLatencySamples > 0 ? Math.round(day.transcriptionLatencyMs / day.transcriptionLatencySamples) : 0,
    summaryLatencyMs: day.summaryLatencySamples > 0 ? Math.round(day.summaryLatencyMs / day.summaryLatencySamples) : 0,
  };
}

function normalizeSharedUsers(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return normalizeSharedUsers(JSON.parse(trimmed) as unknown);
    } catch {
      return trimmed.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseOntology(profile: string | null): Record<string, unknown> | null {
  if (!profile?.trim()) return null;
  const stripped = profile.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!stripped.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function countByUser(rows: Array<{ user_id: string | null }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const id = row.user_id?.trim();
    if (!id) continue;
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

function increment(map: Map<string, number>, key: string | null | undefined, amount = 1): void {
  const id = key?.trim();
  if (!id) return;
  map.set(id, (map.get(id) ?? 0) + amount);
}

function sumUsageByUser(rows: WorkflowUsageRow[], key: 'total_tokens' | 'estimated_cost_usd'): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const id = row.user_id?.trim();
    if (!id) continue;
    const raw = row[key];
    const value = asFiniteNumber(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    map.set(id, (map.get(id) ?? 0) + value);
  }
  return map;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('MEETING_NOTE_SUPABASE_URL') ?? '';
  const serviceRoleKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('MEETING_NOTE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Admin analytics function is not configured.' }, 500);
  }

  const bearerToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  const authResult = bearerToken
    ? await getMicrosoftUserId(bearerToken)
    : { userId: null, error: 'Missing Microsoft bearer token.' };
  if (!authResult.userId) {
    return jsonResponse({ error: authResult.error ?? 'Unauthorized' }, 401);
  }
  if (!ADMIN_MICROSOFT_USER_IDS.has(authResult.userId)) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as RequestBody;
  const range: RangeKey = body.range === '7d' || body.range === '30d' || body.range === '90d' ? body.range : 'all';
  const since = sinceForRange(range);
  const chartWindow = getChartWindow(body.chartStartDate, body.chartEndDate);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [
      appUsersResult,
      notesResult,
      filesResult,
      projectsResult,
      speakersResult,
      promptsResult,
      tokensResult,
      workflowUsageResult,
    ] = await Promise.all([
      adminClient
        .from('app_user')
        .select('microsoft_id, display_name, email, first_seen_at, last_seen_at, created_at')
        .order('last_seen_at', { ascending: false }),
      (since
        ? adminClient.from('note').select('id, user_id, user_name, created_at, summary, summary_edit, transcription, diarization, shared_users').gte('created_at', since)
        : adminClient.from('note').select('id, user_id, user_name, created_at, summary, summary_edit, transcription, diarization, shared_users')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('file').select('id, user_id, source, size_bytes, created_at').gte('created_at', since)
        : adminClient.from('file').select('id, user_id, source, size_bytes, created_at')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('project').select('id, user_id, created_at').gte('created_at', since)
        : adminClient.from('project').select('id, user_id, created_at')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('speaker').select('id, user_id, name, email, microsoft_id, profile, created_at').gte('created_at', since)
        : adminClient.from('speaker').select('id, user_id, name, email, microsoft_id, profile, created_at')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('summary_prompt').select('id, user_id, created_at').gte('created_at', since)
        : adminClient.from('summary_prompt').select('id, user_id, created_at')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('mcp_token').select('id, user_id, last_used_at, revoked_at, created_at').gte('created_at', since)
        : adminClient.from('mcp_token').select('id, user_id, last_used_at, revoked_at, created_at')
      ).order('created_at', { ascending: false }),
      (since
        ? adminClient.from('workflow_usage').select('user_id, stage, provider, prompt_tokens, candidates_tokens, total_tokens, latency_ms, estimated_cost_usd, created_at').gte('created_at', since)
        : adminClient.from('workflow_usage').select('user_id, stage, provider, prompt_tokens, candidates_tokens, total_tokens, latency_ms, estimated_cost_usd, created_at')
      ).order('created_at', { ascending: false }),
    ]);

    for (const result of [
      appUsersResult,
      notesResult,
      filesResult,
      projectsResult,
      speakersResult,
      promptsResult,
      tokensResult,
      workflowUsageResult,
    ]) {
      if (result.error) throw result.error;
    }

    const appUsers = (appUsersResult.data ?? []) as AppUserRow[];
    const notes = (notesResult.data ?? []) as NoteRow[];
    const files = (filesResult.data ?? []) as FileRow[];
    const projects = (projectsResult.data ?? []) as ProjectRow[];
    const speakers = (speakersResult.data ?? []) as SpeakerRow[];
    const prompts = (promptsResult.data ?? []) as PromptRow[];
    const tokens = (tokensResult.data ?? []) as TokenRow[];
    const workflowUsage = (workflowUsageResult.data ?? []) as WorkflowUsageRow[];
    const usageByDate = createUsageDays(chartWindow.days);
    addNoteUsageRows(notes, usageByDate);
    addWorkflowUsageRows(workflowUsage, usageByDate);

    const notesByUser = countByUser(notes);
    const filesByUser = countByUser(files);
    const projectsByUser = countByUser(projects);
    const speakersByUser = countByUser(speakers);
    const promptsByUser = countByUser(prompts);
    const tokensByUser = countByUser(tokens);
    const aiTokensByUser = sumUsageByUser(workflowUsage, 'total_tokens');
    const aiCostByUser = sumUsageByUser(workflowUsage, 'estimated_cost_usd');
    const sharedReceivedByUser = new Map<string, number>();
    for (const note of notes) {
      for (const sharedId of normalizeSharedUsers(note.shared_users)) {
        increment(sharedReceivedByUser, sharedId);
      }
    }

    const knownUserIds = new Set<string>();
    appUsers.forEach((u) => knownUserIds.add(u.microsoft_id));
    [notesByUser, filesByUser, projectsByUser, speakersByUser, promptsByUser, tokensByUser, sharedReceivedByUser, aiTokensByUser].forEach((map) =>
      map.forEach((_, id) => knownUserIds.add(id))
    );

    const appUserById = new Map(appUsers.map((u) => [u.microsoft_id, u]));
    const fallbackNameByUser = new Map<string, string>();
    notes.forEach((note) => {
      if (note.user_id && note.user_name && !fallbackNameByUser.has(note.user_id)) {
        fallbackNameByUser.set(note.user_id, note.user_name);
      }
    });

    const userUsage = [...knownUserIds].map((id) => {
      const appUser = appUserById.get(id) ?? null;
      const noteCount = notesByUser.get(id) ?? 0;
      const fileCount = filesByUser.get(id) ?? 0;
      const projectCount = projectsByUser.get(id) ?? 0;
      const speakerCount = speakersByUser.get(id) ?? 0;
      const promptCount = promptsByUser.get(id) ?? 0;
      const tokenCount = tokensByUser.get(id) ?? 0;
      const sharedNotesReceived = sharedReceivedByUser.get(id) ?? 0;
      const aiTokens = aiTokensByUser.get(id) ?? 0;
      const aiEstimatedCostUsd = aiCostByUser.get(id) ?? 0;
      return {
        userId: id,
        displayName: appUser?.display_name || fallbackNameByUser.get(id) || 'Unknown user',
        email: appUser?.email || '',
        firstSeenAt: appUser?.first_seen_at ?? appUser?.created_at ?? null,
        lastSeenAt: appUser?.last_seen_at ?? null,
        noteCount,
        fileCount,
        projectCount,
        speakerCount,
        promptCount,
        tokenCount,
        sharedNotesReceived,
        aiTokens,
        aiEstimatedCostUsd,
        activityCount: noteCount + fileCount + projectCount + speakerCount + promptCount,
      };
    }).sort((a, b) => b.activityCount - a.activityCount || a.displayName.localeCompare(b.displayName));

    const speakerProfiles = speakers.map((speaker) => {
      const ontology = parseOntology(speaker.profile);
      return {
        id: speaker.id,
        userId: speaker.user_id ?? '',
        ownerName: speaker.user_id ? appUserById.get(speaker.user_id)?.display_name || fallbackNameByUser.get(speaker.user_id) || 'Unknown user' : 'Unknown user',
        name: speaker.name || 'Unnamed speaker',
        email: speaker.email || '',
        microsoftId: speaker.microsoft_id || '',
        createdAt: speaker.created_at,
        hasProfile: Boolean(speaker.profile?.trim()),
        hasOntology: Boolean(ontology),
        ontology,
      };
    });

    const totalFileBytes = files.reduce((sum, file) => sum + (typeof file.size_bytes === 'number' ? file.size_bytes : 0), 0);
    const transcriptionUsageRows = workflowUsage.filter((row) => row.stage === 'transcription');
    const summaryUsageRows = workflowUsage.filter((row) => row.stage === 'summarization');
    const assemblyTranscriptionRows = transcriptionUsageRows.filter((row) => row.provider === 'assemblyai');
    const geminiSummaryRows = summaryUsageRows.filter((row) => row.provider === 'google-gemini');
    const totalAiPromptTokens = geminiSummaryRows.reduce((sum, row) => sum + asFiniteNumber(row.prompt_tokens), 0);
    const totalAiCandidateTokens = geminiSummaryRows.reduce((sum, row) => sum + asFiniteNumber(row.candidates_tokens), 0);
    const totalAiTokens = geminiSummaryRows.reduce((sum, row) => sum + asFiniteNumber(row.total_tokens), 0);
    const totalAiEstimatedCostUsd = workflowUsage.reduce((sum, row) => sum + asFiniteNumber(row.estimated_cost_usd), 0);
    const assemblyTranscriptionCostUsd = assemblyTranscriptionRows.reduce((sum, row) => sum + asFiniteNumber(row.estimated_cost_usd), 0);
    const geminiSummaryCostUsd = geminiSummaryRows.reduce((sum, row) => sum + asFiniteNumber(row.estimated_cost_usd), 0);
    const transcriptionLatencyRows = assemblyTranscriptionRows.filter((row) => asFiniteNumber(row.latency_ms) > 0);
    const summaryLatencyRows = geminiSummaryRows.filter((row) => asFiniteNumber(row.latency_ms) > 0);
    const averageTranscriptionLatencyMs = transcriptionLatencyRows.length > 0
      ? Math.round(transcriptionLatencyRows.reduce((sum, row) => sum + asFiniteNumber(row.latency_ms), 0) / transcriptionLatencyRows.length)
      : 0;
    const averageSummaryLatencyMs = summaryLatencyRows.length > 0
      ? Math.round(summaryLatencyRows.reduce((sum, row) => sum + asFiniteNumber(row.latency_ms), 0) / summaryLatencyRows.length)
      : 0;
    const sharedNotes = notes.filter((note) => normalizeSharedUsers(note.shared_users).length > 0);
    const summariesGenerated = notes.filter((note) => Boolean(note.summary?.trim() || note.summary_edit?.trim())).length;
    const transcriptionsGenerated = notes.filter((note) => Boolean(note.transcription?.trim()) || Boolean(note.diarization)).length;
    const activeUserIds = new Set<string>();
    userUsage.forEach((u) => {
      if (u.activityCount > 0) activeUserIds.add(u.userId);
    });

    return jsonResponse({
      range,
      since,
      generatedAt: new Date().toISOString(),
      totals: {
        signedUpUsers: appUsers.length,
        activeUsers: activeUserIds.size,
        notes: notes.length,
        summariesGenerated,
        transcriptionsGenerated,
        files: files.length,
        recordedFiles: files.filter((file) => file.source === 'recording').length,
        uploadedFiles: files.filter((file) => file.source === 'upload').length,
        fileBytes: totalFileBytes,
        projects: projects.length,
        speakerProfiles: speakers.length,
        ontologyProfiles: speakerProfiles.filter((speaker) => speaker.hasOntology).length,
        emptySpeakerProfiles: speakerProfiles.filter((speaker) => !speaker.hasProfile).length,
        sharedNotes: sharedNotes.length,
        summaryPrompts: prompts.length,
        mcpTokens: tokens.length,
        activeMcpTokens: tokens.filter((token) => !token.revoked_at).length,
        aiCalls: workflowUsage.length,
        transcriptionCalls: transcriptionUsageRows.length,
        assemblyTranscriptionCalls: assemblyTranscriptionRows.length,
        summaryCalls: summaryUsageRows.length,
        geminiSummaryCalls: geminiSummaryRows.length,
        aiPromptTokens: totalAiPromptTokens,
        aiCandidateTokens: totalAiCandidateTokens,
        aiTokens: totalAiTokens,
        aiEstimatedCostUsd: Number(totalAiEstimatedCostUsd.toFixed(6)),
        assemblyTranscriptionCostUsd: Number(assemblyTranscriptionCostUsd.toFixed(6)),
        geminiSummaryCostUsd: Number(geminiSummaryCostUsd.toFixed(6)),
        averageTranscriptionLatencyMs,
        averageSummaryLatencyMs,
      },
      usageChart: {
        startDate: chartWindow.startDate,
        endDate: chartWindow.endDate,
        days: chartWindow.days.map((date) => finalizeUsageDay(usageByDate.get(date)!)),
      },
      users: userUsage,
      speakerProfiles,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
