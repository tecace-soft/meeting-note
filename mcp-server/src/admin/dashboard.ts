import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getEnv } from '../lib/env.js';
import { getMcpDashboardData } from '../lib/mcpTracking.js';
import { getDataContext } from '../lib/supabase.js';

type JsonRecord = Record<string, unknown>;
const require = createRequire(import.meta.url);

interface AdminUser {
  id: string;
  displayName: string;
  email: string;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendLocalMsalScript(res: ServerResponse): Promise<void> {
  const packageJsonPath = require.resolve('@azure/msal-browser/package.json');
  const scriptPath = join(dirname(packageJsonPath), 'lib', 'msal-browser.min.js');
  const script = await readFile(scriptPath);
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  });
  res.end(script);
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

async function getMicrosoftUser(accessToken: string): Promise<AdminUser | null> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as JsonRecord;
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : 'User';
  const email =
    typeof data.mail === 'string' && data.mail.trim()
      ? data.mail.trim()
      : typeof data.userPrincipalName === 'string'
        ? data.userPrincipalName.trim()
        : '';
  if (!id) return null;
  return { id, displayName, email };
}

async function requireAdmin(req: IncomingMessage): Promise<AdminUser | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getMicrosoftUser(token);
  if (!user) return null;
  const env = getEnv();
  const allowedIds = env.mcpAdminMicrosoftIds;
  const allowedEmails = env.mcpAdminEmails;
  if (allowedIds.size === 0 && allowedEmails.size === 0) return user;
  if (allowedIds.has(user.id.toLowerCase())) return user;
  if (user.email && allowedEmails.has(user.email.toLowerCase())) return user;
  return null;
}

async function fetchLocalHealth(req: IncomingMessage): Promise<JsonRecord> {
  const host = req.headers.host ?? 'localhost:3000';
  const response = await fetch(`http://${host}/health?deep=1`);
  return (await response.json()) as JsonRecord;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function emptyDashboardData(health: JsonRecord) {
  const metrics = (health.metrics && typeof health.metrics === 'object' ? health.metrics : {}) as JsonRecord;
  return {
    dataSource: 'empty',
    health,
    summary: {
      totalRequests: asNumber(metrics.totalRequests),
      activeRequests: asNumber(metrics.activeRequests),
      completedRequests: asNumber(metrics.completedRequests),
      failedRequests: asNumber(metrics.failedRequests),
      disconnectedRequests: asNumber(metrics.disconnectedRequests),
      uniqueUsers: 0,
      totalToolCalls: 0,
      estimatedTokens: null,
      avgLatencyMs: 0,
    },
    dailyUsage: [],
    platformUsage: [],
    sessions: [],
    toolCalls: [],
  };
}

function getString(row: JsonRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function getDateKey(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : 'Unknown';
}

async function fetchDbDashboardData(health: JsonRecord) {
  const { supabase } = getDataContext();
  const { data, error } = await supabase.from('mcp_session').select('*').order('started_at', { ascending: false }).limit(250);
  if (error || !Array.isArray(data)) return null;

  const rows = data as JsonRecord[];
  const sessionIds = rows
    .map((row) => (typeof row.id === 'string' ? row.id : ''))
    .filter(Boolean);
  const { data: toolCallData } = sessionIds.length
    ? await supabase.from('mcp_tool_call').select('*').in('session_id', sessionIds).order('time', { ascending: false })
    : { data: [] as unknown[] };
  const toolCallRows = Array.isArray(toolCallData) ? toolCallData as JsonRecord[] : [];
  const toolCallsBySession = new Map<string, JsonRecord[]>();
  for (const call of toolCallRows) {
    const sessionId = typeof call.session_id === 'string' ? call.session_id : '';
    if (!sessionId) continue;
    const calls = toolCallsBySession.get(sessionId) ?? [];
    calls.push(call);
    toolCallsBySession.set(sessionId, calls);
  }

  const sessions = rows.map((row) => {
    const sessionId = typeof row.id === 'string' ? row.id : '';
    const persistedCalls = toolCallsBySession.get(sessionId) ?? [];
    const toolNames = persistedCalls.length
      ? persistedCalls.map((call) => getString(call, ['tool'], 'Unknown tool'))
      : Array.isArray(row.tool_names)
        ? row.tool_names
        : [];
    return {
      id: row.id ?? row.request_id ?? 'session',
      startedAt: row.started_at ?? row.created_at ?? null,
      user: getString(row, ['microsoft_email', 'email', 'user_id'], 'Unknown'),
      platform: getString(row, ['platform', 'endpoint'], 'Unknown'),
      status: getString(row, ['status'], 'unknown'),
      query: getString(row, ['user_query', 'query', 'user_intent']),
      response: getString(row, ['generated_response', 'response', 'final_answer']),
      toolCalls: toolNames,
      latencyMs: row.duration_ms ?? null,
      tokens: row.total_tokens ?? null,
      errorMessage: row.error_message ?? null,
    };
  });

  const userBySession = new Map(
    rows.map((row) => [typeof row.id === 'string' ? row.id : '', getString(row, ['microsoft_email', 'email', 'user_id'], 'Unknown')])
  );
  const toolCallsFromRows = toolCallRows.map((record) => ({
    time: record.time ?? record.created_at ?? null,
    tool: getString(record, ['tool', 'name'], 'Unknown tool'),
    user: getString(record, ['user_id'], userBySession.get(getString(record, ['session_id'])) ?? 'Unknown'),
    userIntent: getString(record, ['userIntent', 'user_intent']),
    reasonForToolChoice: getString(record, ['reasonForToolChoice', 'reason_for_tool_choice']),
    expectedAnswerType: getString(record, ['expectedAnswerType', 'expected_answer_type']),
    input: record.input ?? record.arguments ?? {},
    outputPreview: getString(record, ['outputPreview', 'output_preview']),
    outcome: getString(record, ['outcome', 'status'], 'unknown'),
    durationMs: record.durationMs ?? record.duration_ms ?? null,
    notes: getString(record, ['notes', 'errorMessage', 'error_message', 'reasonForToolChoice', 'reason_for_tool_choice']),
  }));

  const uniqueUsers = new Set(rows.map((row) => row.user_id).filter(Boolean)).size;
  const completed = rows.filter((row) => row.status === 'completed');
  const failed = rows.filter((row) => row.status === 'failed');
  const totalTokens = rows.reduce((sum, row) => sum + asNumber(row.total_tokens), 0);
  const totalToolCalls = toolCallsFromRows.length || rows.reduce((sum, row) => sum + asNumber(row.tool_call_count), 0);
  const avgLatencyMs = completed.length
    ? Math.round(completed.reduce((sum, row) => sum + asNumber(row.duration_ms), 0) / completed.length)
    : 0;

  const daily = new Map<string, { date: string; users: Set<unknown>; requests: number; toolCalls: number; tokens: number; failures: number }>();
  const platforms = new Map<string, { platform: string; users: Set<unknown>; requests: number; toolCalls: number }>();
  for (const row of rows) {
    const date = getDateKey(row.started_at ?? row.created_at);
    const dailyRow = daily.get(date) ?? { date, users: new Set(), requests: 0, toolCalls: 0, tokens: 0, failures: 0 };
    dailyRow.requests += 1;
    dailyRow.toolCalls += asNumber(row.tool_call_count);
    dailyRow.tokens += asNumber(row.total_tokens);
    if (row.user_id) dailyRow.users.add(row.user_id);
    if (row.status === 'failed') dailyRow.failures += 1;
    daily.set(date, dailyRow);

    const platform = getString(row, ['platform', 'endpoint'], 'Unknown');
    const platformRow = platforms.get(platform) ?? { platform, users: new Set(), requests: 0, toolCalls: 0 };
    platformRow.requests += 1;
    platformRow.toolCalls += asNumber(row.tool_call_count);
    if (row.user_id) platformRow.users.add(row.user_id);
    platforms.set(platform, platformRow);
  }

  return {
    dataSource: 'database',
    health,
    summary: {
      totalRequests: rows.length,
      activeRequests: asNumber((health.metrics as JsonRecord | undefined)?.activeRequests),
      completedRequests: completed.length,
      failedRequests: failed.length,
      disconnectedRequests: asNumber((health.metrics as JsonRecord | undefined)?.disconnectedRequests),
      uniqueUsers,
      totalToolCalls,
      estimatedTokens: totalTokens || null,
      avgLatencyMs,
    },
    dailyUsage: [...daily.values()].map((row) => ({
      date: row.date,
      users: row.users.size,
      requests: row.requests,
      toolCalls: row.toolCalls,
      tokens: row.tokens || null,
      failures: row.failures,
    })),
    platformUsage: [...platforms.values()].map((row) => ({
      platform: row.platform,
      users: row.users.size,
      requests: row.requests,
      toolCalls: row.toolCalls,
    })),
    sessions,
    toolCalls: toolCallsFromRows,
  };
}

async function fetchTrackingData(health: JsonRecord) {
  const memoryData = getMcpDashboardData();
  if (Array.isArray(memoryData.sessions) && memoryData.sessions.length > 0) {
    return { dataSource: 'memory', health, ...memoryData };
  }
  const dbData = await fetchDbDashboardData(health).catch(() => null);
  return dbData ?? emptyDashboardData(health);
}

function dashboardHtml(): string {
  const env = getEnv();
  const clientId = env.mcpAdminClientId ?? '';
  const tenantId = env.mcpAdminTenantId ?? 'common';
  const adminConfigured = env.mcpAdminEmails.size > 0 || env.mcpAdminMicrosoftIds.size > 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meeting Note MCP Dashboard</title>
  <script src="/admin/msal-browser.min.js"></script>
  <style>
    :root {
      --tc-navy: #18295f;
      --tc-indigo: #525bd8;
      --tc-cyan: #0f93c8;
      --bg: #f6f8fc;
      --surface: #ffffff;
      --surface-soft: #f7f9ff;
      --text: #111827;
      --text-secondary: #4b5563;
      --text-muted: #6b7280;
      --border: #dde3ee;
      --border-soft: #edf1f7;
      --accent: var(--tc-indigo);
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
      --gradient: linear-gradient(90deg, var(--tc-cyan), var(--tc-indigo));
      font-family: Sora, "Wanted Sans Variable", "Wanted Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    button { font: inherit; }
    .login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: linear-gradient(135deg, #f7fbff 0%, #eef3ff 100%); }
    .login-panel { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border-soft); border-radius: 12px; padding: 30px; box-shadow: 0 24px 60px rgba(24, 41, 95, .10); }
    .brand { color: var(--tc-navy); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; font-size: 12px; }
    h1, h2, h3 { font-family: Poppins, "Wanted Sans Variable", "Wanted Sans", sans-serif; letter-spacing: 0; }
    h1 { margin: 10px 0 8px; font-size: 26px; color: var(--tc-navy); }
    p { color: var(--text-secondary); line-height: 1.5; }
    .primary { border: 0; border-radius: 8px; background: var(--gradient); color: #fff; padding: 11px 14px; font-weight: 700; cursor: pointer; }
    .primary:hover { filter: brightness(.98); }
    .hidden { display: none !important; }
    .layout { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
    .side { background: var(--surface); border-right: 1px solid var(--border-soft); padding: 22px 16px; }
    .side h1 { font-size: 22px; }
    .side p { font-size: 13px; margin-top: 8px; }
    .nav { display: grid; gap: 4px; margin-top: 24px; }
    .nav button { border: 0; border-left: 3px solid transparent; text-align: left; background: transparent; color: var(--text-secondary); padding: 10px 11px; cursor: pointer; font-weight: 700; font-size: 14px; }
    .nav button:hover { color: var(--tc-navy); background: #fafbff; }
    .nav button.active { color: var(--accent); border-left-color: var(--accent); background: #f5f7ff; }
    .main { min-width: 0; padding: 26px 28px; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--border-soft); }
    .top h2 { margin: 0; font-size: 24px; color: var(--tc-navy); }
    .top p { margin: 6px 0 0; font-size: 13px; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .icon-button { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--tc-navy); cursor: pointer; }
    .icon-button:hover { border-color: #cbd5e1; background: #fbfcff; }
    .icon-button svg { width: 17px; height: 17px; stroke-width: 2; }
    .meta-text { color: var(--text-muted); font-size: 12px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 8px; padding: 16px; }
    .metric-label { color: var(--text-muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .metric-value { margin-top: 8px; font-size: 25px; font-weight: 800; color: var(--tc-navy); }
    .metric-sub { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
    .section { margin-top: 14px; }
    .section-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 10px; }
    .section-title h3 { margin: 0; font-size: 16px; color: var(--text); }
    .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 800; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; }
    .ok { color: #16865a; }
    .warn { color: #a16207; }
    .bad { color: #dc2626; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--border-soft); padding: 10px 8px; }
    td { border-bottom: 1px solid var(--border-soft); padding: 10px 8px; vertical-align: top; }
    tbody tr:hover { background: #fbfcff; }
    .label { color: var(--text-muted); font-size: 12px; font-weight: 700; }
    .tool-token { display: inline-flex; align-items: center; border-radius: 6px; padding: 2px 6px; background: var(--surface-soft); color: var(--tc-navy); font-size: 12px; font-weight: 700; }
    .query { max-width: 440px; color: var(--text); line-height: 1.45; }
    .muted { color: var(--text-muted); }
    .tools { display: flex; flex-wrap: wrap; gap: 5px; }
    .detail { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; background: #172033; color: #e5e7eb; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.55; }
    .input-preview { max-height: 180px; background: #f8fafc; color: #334155; border: 1px solid var(--border-soft); }
    .panel { display: none; }
    .panel.active { display: block; }
    .empty { border: 1px dashed var(--border); border-radius: 8px; padding: 18px; color: var(--text-muted); background: #fbfcff; }
    .table-wrap { overflow-x: auto; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .side { border-right: 0; border-bottom: 1px solid var(--border); }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail { grid-template-columns: 1fr; }
      .top { flex-direction: column; }
    }
  </style>
</head>
<body>
  <section id="login" class="login-page">
    <div class="login-panel">
      <div class="brand">TecAce Meeting Note</div>
      <h1>MCP Dashboard</h1>
      <p>Sign in with your Microsoft account to review MCP usage, tool selection, request health, and evaluation logs.</p>
      <button class="primary" id="login-button">Sign in with Microsoft</button>
      <p id="login-error" class="muted"></p>
    </div>
  </section>
  <div id="dashboard" class="layout hidden">
    <aside class="side">
      <div class="brand">TecAce</div>
      <h1>MCP Dashboard</h1>
      <p>Review usage, tool selection, responses, failures, platforms, and token estimates.</p>
      <div class="nav">
        <button class="active" data-tab="overview">Overview</button>
        <button data-tab="sessions">Queries and Responses</button>
        <button data-tab="tools">Tool Usage</button>
        <button data-tab="analytics">Daily Analytics</button>
        <button data-tab="health">Health</button>
      </div>
    </aside>
    <main class="main">
      <div class="top">
        <div>
          <h2 id="page-title">Overview</h2>
          <p id="page-subtitle">Live MCP status and usage signals for tool evaluation.</p>
        </div>
        <div class="actions">
          <span id="data-source" class="meta-text">Loading</span>
          <span id="server-status" class="status warn"><span class="dot"></span>Loading</span>
          <button class="icon-button" id="refresh" title="Refresh" aria-label="Refresh dashboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M21 12a9 9 0 0 1-15.3 6.4" />
              <path d="M3 12A9 9 0 0 1 18.3 5.6" />
              <path d="M18 2v4h-4" />
              <path d="M6 22v-4h4" />
            </svg>
          </button>
          <button class="icon-button" id="logout" title="Sign out" aria-label="Sign out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        </div>
      </div>

      <section class="panel active" id="panel-overview">
        <div class="grid">
          <div class="card"><div class="metric-label">Requests</div><div class="metric-value" id="metric-requests">-</div><div class="metric-sub">Tracked MCP sessions</div></div>
          <div class="card"><div class="metric-label">Users</div><div class="metric-value" id="metric-users">-</div><div class="metric-sub">Unique scoped users</div></div>
          <div class="card"><div class="metric-label">Tool Calls</div><div class="metric-value" id="metric-tools">-</div><div class="metric-sub">Tracked tool invocations</div></div>
          <div class="card"><div class="metric-label">Tokens</div><div class="metric-value" id="metric-tokens">-</div><div class="metric-sub">Only shown when logged by client</div></div>
        </div>
        <div class="section card">
          <div class="section-title"><h3>Recent Queries</h3><span class="label" id="session-count">0 sessions</span></div>
          <div class="table-wrap"><table><thead><tr><th>User</th><th>Platform</th><th>Query</th><th>Tools</th><th>Status</th></tr></thead><tbody id="recent-sessions"></tbody></table></div>
        </div>
      </section>

      <section class="panel" id="panel-sessions">
        <div class="section card">
          <div class="section-title"><h3>User Queries and Generated Responses</h3><span class="label">Review quality</span></div>
          <div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Query</th><th>Generated Response</th><th>Latency</th></tr></thead><tbody id="session-table"></tbody></table></div>
        </div>
      </section>

      <section class="panel" id="panel-tools">
        <div class="section card">
          <div class="section-title"><h3>Tool Calls</h3><span class="label">Input and outcome</span></div>
          <div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool</th><th>User</th><th>Input</th><th>Outcome</th><th>Notes</th></tr></thead><tbody id="tool-table"></tbody></table></div>
        </div>
      </section>

      <section class="panel" id="panel-analytics">
        <div class="detail">
          <div class="card"><div class="section-title"><h3>Daily Usage</h3><span class="label">Real tracked rows only</span></div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Users</th><th>Requests</th><th>Tools</th><th>Tokens</th><th>Failures</th></tr></thead><tbody id="daily-table"></tbody></table></div></div>
          <div class="card"><div class="section-title"><h3>Platform Usage</h3><span class="label">Client source</span></div><div class="table-wrap"><table><thead><tr><th>Platform</th><th>Users</th><th>Requests</th><th>Tools</th></tr></thead><tbody id="platform-table"></tbody></table></div></div>
        </div>
      </section>

      <section class="panel" id="panel-health">
        <div class="detail">
          <div class="card"><div class="section-title"><h3>Server Health</h3><span class="label" id="uptime">-</span></div><pre id="health-json">{}</pre></div>
          <div class="card"><div class="section-title"><h3>Evaluation Notes</h3><span class="label">What to check</span></div><div class="empty">Look for mismatches between user intent and selected tools, empty results, unauthorized scopes, slow requests, disconnects, and responses that cite the wrong note or project context.</div></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const config = {
      clientId: ${JSON.stringify(clientId)},
      authority: ${JSON.stringify(`https://login.microsoftonline.com/${tenantId}`)},
      adminConfigured: ${JSON.stringify(adminConfigured)}
    };
    const scopes = ['User.Read'];
    const titleMap = {
      overview: ['Overview', 'Live MCP status and usage signals for tool evaluation.'],
      sessions: ['Queries and Responses', 'Inspect user prompts, generated responses, and whether the answer was useful.'],
      tools: ['Tool Usage', 'Review which tools were called and whether their inputs made sense.'],
      analytics: ['Daily Analytics', 'Track usage by day, platform, users, requests, tools, and tokens.'],
      health: ['Health', 'Check server status, dependencies, failures, and disconnects.'],
    };
    const fmt = new Intl.NumberFormat();
    let msalClient = null;
    let account = null;

    function text(id, value) { document.getElementById(id).textContent = value; }
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
    function row(cells) { return '<tr>' + cells.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>'; }
    function emptyRow(cols, label) { return '<tr><td colspan="' + cols + '"><div class="empty">' + label + '</div></td></tr>'; }
    function statusPill(status) {
      const cls = status === 'completed' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
      return '<span class="status ' + cls + '"><span class="dot"></span>' + escapeHtml(status || 'unknown') + '</span>';
    }
    function tools(items) { return '<div class="tools">' + (items || []).map((item) => '<span class="tool-token">' + escapeHtml(item) + '</span>').join('') + '</div>'; }
    function formatTokens(value) { return value == null ? 'N/A' : fmt.format(value); }
    function isMeaningfulSession(session) {
      return Boolean(
        (session.query && String(session.query).trim()) ||
        (session.response && String(session.response).trim()) ||
        (session.toolCalls && session.toolCalls.length)
      );
    }

    async function getToken() {
      const response = await msalClient.acquireTokenSilent({ scopes, account });
      return response.accessToken;
    }
    async function api(path) {
      const token = await getToken();
      const res = await fetch(path, { headers: { authorization: 'Bearer ' + token } });
      if (res.status === 401 || res.status === 403) throw new Error('You are not authorized to view this dashboard.');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    function render(data) {
      const summary = data.summary || {};
      const sessions = data.sessions || [];
      const meaningfulSessions = sessions.filter(isMeaningfulSession);
      const toolCalls = data.toolCalls || [];
      const dailyUsage = data.dailyUsage || [];
      const platformUsage = data.platformUsage || [];
      const health = data.health || {};
      const ok = health.ok !== false;
      document.getElementById('server-status').className = 'status ' + (ok ? 'ok' : 'bad');
      document.getElementById('server-status').innerHTML = '<span class="dot"></span>' + (ok ? 'Healthy' : 'Unhealthy');
      text('data-source', 'Source: ' + (data.dataSource || 'unknown'));
      text('metric-requests', fmt.format(summary.totalRequests || 0));
      text('metric-users', fmt.format(summary.uniqueUsers || 0));
      text('metric-tools', fmt.format(summary.totalToolCalls || 0));
      text('metric-tokens', formatTokens(summary.estimatedTokens));
      text('session-count', meaningfulSessions.length + ' sessions');
      document.getElementById('recent-sessions').innerHTML = meaningfulSessions.length ? meaningfulSessions.slice(0, 6).map((s) => row([
        escapeHtml(s.user), '<span class="label">' + escapeHtml(s.platform) + '</span>', '<div class="query">' + escapeHtml(s.query) + '</div>', tools(s.toolCalls), statusPill(s.status)
      ])).join('') : emptyRow(5, 'No tracked user/tool sessions yet.');
      document.getElementById('session-table').innerHTML = meaningfulSessions.length ? meaningfulSessions.map((s) => row([
        escapeHtml(s.startedAt ? new Date(s.startedAt).toLocaleString() : ''), escapeHtml(s.user), '<div class="query">' + escapeHtml(s.query) + '</div>', '<div class="query muted">' + escapeHtml(s.response) + '</div>', escapeHtml((s.latencyMs || 0) + ' ms')
      ])).join('') : emptyRow(5, 'No query/response records available.');
      document.getElementById('tool-table').innerHTML = toolCalls.length ? toolCalls.map((t) => row([
        escapeHtml(t.time ? new Date(t.time).toLocaleString() : ''), '<span class="tool-token">' + escapeHtml(t.tool) + '</span>', escapeHtml(t.user), '<pre class="input-preview">' + escapeHtml(JSON.stringify(t.input || {}, null, 2)) + '</pre>', statusPill(t.outcome), escapeHtml(t.notes || t.reasonForToolChoice || '')
      ])).join('') : emptyRow(6, 'No tracked tool calls yet.');
      document.getElementById('daily-table').innerHTML = dailyUsage.length ? dailyUsage.map((d) => row([
        escapeHtml(d.date), fmt.format(d.users || 0), fmt.format(d.requests || 0), fmt.format(d.toolCalls || 0), formatTokens(d.tokens), fmt.format(d.failures || 0)
      ])).join('') : emptyRow(6, 'No daily analytics rows yet.');
      document.getElementById('platform-table').innerHTML = platformUsage.length ? platformUsage.map((p) => row([
        escapeHtml(p.platform), fmt.format(p.users || 0), fmt.format(p.requests || 0), fmt.format(p.toolCalls || 0)
      ])).join('') : emptyRow(4, 'No platform usage rows yet.');
      text('uptime', Math.round(health.uptimeSeconds || 0) + 's uptime');
      text('health-json', JSON.stringify(health, null, 2));
    }
    async function load() { render(await api('/admin/api/overview')); }
    async function init() {
      if (!config.clientId) {
        text('login-error', 'MCP_ADMIN_CLIENT_ID or VITE_MSAL_CLIENT_ID is not configured.');
        return;
      }
      if (!window.msal) {
        text('login-error', 'Microsoft sign-in library failed to load. Refresh the page and try again.');
        return;
      }
      msalClient = new msal.PublicClientApplication({
        auth: { clientId: config.clientId, authority: config.authority, redirectUri: window.location.origin + '/admin' },
        cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: true },
      });
      await msalClient.initialize();
      await msalClient.handleRedirectPromise();
      account = msalClient.getAllAccounts()[0] || null;
      if (!account) {
        document.getElementById('login').classList.remove('hidden');
        document.getElementById('dashboard').classList.add('hidden');
        return;
      }
      document.getElementById('login').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      await load();
    }
    document.getElementById('login-button').addEventListener('click', () => {
      msalClient.loginRedirect({ scopes }).catch((error) => text('login-error', error.message || String(error)));
    });
    document.getElementById('logout').addEventListener('click', () => msalClient.logoutRedirect({ postLogoutRedirectUri: window.location.origin + '/admin' }));
    document.getElementById('refresh').addEventListener('click', () => load().catch((error) => alert(error.message || String(error))));
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === button));
        document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tab));
        text('page-title', titleMap[tab][0]);
        text('page-subtitle', titleMap[tab][1]);
      });
    });
    init().catch((error) => {
      document.getElementById('login').classList.remove('hidden');
      document.getElementById('dashboard').classList.add('hidden');
      text('login-error', error.message || String(error));
    });
    setInterval(() => { if (account) load().catch(() => undefined); }, 30000);
  </script>
</body>
</html>`;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/admin/msal-browser.min.js') {
    try {
      await sendLocalMsalScript(res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    sendHtml(res, dashboardHtml());
    return true;
  }

  if (url.pathname === '/admin/api/overview') {
    const admin = await requireAdmin(req);
    if (!admin) {
      sendJson(res, 401, { error: 'Microsoft sign-in is required for the MCP dashboard.' });
      return true;
    }
    try {
      const health = await fetchLocalHealth(req);
      sendJson(res, 200, { admin, ...(await fetchTrackingData(health)) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (url.pathname === '/admin/health') {
    const admin = await requireAdmin(req);
    if (!admin) {
      sendJson(res, 401, { error: 'Microsoft sign-in is required for the MCP dashboard.' });
      return true;
    }
    try {
      sendJson(res, 200, await fetchLocalHealth(req));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
