import type { IncomingMessage, ServerResponse } from 'node:http';
import { getEnv, type MeetingNoteEnv } from '../lib/env.js';
import { getDataContext } from '../lib/supabase.js';

interface AdminUser {
  id: string;
  email?: string;
  displayName?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const authorization = getHeaderValue(req, 'authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function getMicrosoftAdminUser(accessToken: string): Promise<AdminUser | undefined> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const data = (await response.json()) as {
    id?: unknown;
    mail?: unknown;
    userPrincipalName?: unknown;
    displayName?: unknown;
  };
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) return undefined;
  return {
    id,
    email:
      typeof data.mail === 'string' && data.mail.trim()
        ? data.mail.trim()
        : typeof data.userPrincipalName === 'string'
          ? data.userPrincipalName.trim()
          : undefined,
    displayName: typeof data.displayName === 'string' ? data.displayName.trim() : undefined,
  };
}

async function requireAdmin(req: IncomingMessage, env: MeetingNoteEnv): Promise<AdminUser | undefined> {
  const token = getBearerToken(req);
  if (!token) return undefined;
  const user = await getMicrosoftAdminUser(token);
  if (!user) return undefined;
  const idAllowed = env.mcpAdminMicrosoftIds.has(user.id.toLowerCase());
  const emailAllowed = user.email ? env.mcpAdminEmails.has(user.email.toLowerCase()) : false;
  return idAllowed || emailAllowed ? user : undefined;
}

function dayStartIso(daysBack: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString();
}

async function getOverview() {
  const { supabase } = getDataContext();
  const since = dayStartIso(0);
  const sevenDaysAgo = dayStartIso(6);
  const [todaySessions, todayTools, failedTools, recentSessions, recentTools] = await Promise.all([
    supabase.from('mcp_session').select('id, user_hash, platform, status', { count: 'exact' }).gte('started_at', since),
    supabase.from('mcp_tool_call').select('id, tool_name, duration_ms, is_error', { count: 'exact' }).gte('started_at', since),
    supabase.from('mcp_tool_call').select('id', { count: 'exact', head: true }).eq('is_error', true).gte('started_at', since),
    supabase
      .from('mcp_session')
      .select('id, request_id, user_hash, endpoint, platform, auth_mode, status, status_code, duration_ms, started_at')
      .order('started_at', { ascending: false })
      .limit(20),
    supabase
      .from('mcp_tool_call')
      .select('id, session_id, tool_name, is_error, duration_ms, started_at')
      .gte('started_at', sevenDaysAgo)
      .order('started_at', { ascending: false })
      .limit(200),
  ]);

  for (const result of [todaySessions, todayTools, failedTools, recentSessions, recentTools]) {
    if (result.error) throw result.error;
  }

  const sessions = (todaySessions.data ?? []) as Array<{ user_hash?: string | null; platform?: string | null }>;
  const tools = (todayTools.data ?? []) as Array<{ tool_name?: string | null; duration_ms?: number | null; is_error?: boolean | null }>;
  const uniqueUsers = new Set(sessions.map((session) => session.user_hash).filter(Boolean)).size;
  const platformCounts = sessions.reduce<Record<string, number>>((counts, session) => {
    const platform = session.platform || 'unknown';
    counts[platform] = (counts[platform] ?? 0) + 1;
    return counts;
  }, {});
  const toolCounts = tools.reduce<Record<string, number>>((counts, tool) => {
    const name = tool.tool_name || 'unknown';
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  const durations = tools.map((tool) => tool.duration_ms ?? 0).filter((duration) => duration > 0);

  return {
    totals: {
      sessionsToday: todaySessions.count ?? 0,
      toolCallsToday: todayTools.count ?? 0,
      failedToolCallsToday: failedTools.count ?? 0,
      uniqueUsersToday: uniqueUsers,
      averageToolDurationMs: durations.length
        ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : 0,
    },
    platformCounts,
    toolCounts,
    recentSessions: recentSessions.data ?? [],
    recentTools: recentTools.data ?? [],
  };
}

async function getSessions(url: URL) {
  const { supabase } = getDataContext();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  const { data, error } = await supabase
    .from('mcp_session')
    .select('id, request_id, user_hash, endpoint, platform, auth_mode, method, path, status, status_code, duration_ms, error_message, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { sessions: data ?? [] };
}

async function getToolCalls(url: URL) {
  const { supabase } = getDataContext();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
  let query = supabase
    .from('mcp_tool_call')
    .select('id, session_id, request_id, user_hash, tool_name, arguments_preview, result_preview, is_error, error_message, duration_ms, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(limit);
  const toolName = url.searchParams.get('toolName')?.trim();
  if (toolName) query = query.eq('tool_name', toolName);
  const { data, error } = await query;
  if (error) throw error;
  return { toolCalls: data ?? [] };
}

async function saveEvaluation(req: IncomingMessage, admin: AdminUser) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  const { supabase } = getDataContext();
  const { data, error } = await supabase
    .from('mcp_evaluation')
    .insert({
      session_id: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null,
      tool_call_id: typeof body.toolCallId === 'string' && body.toolCallId ? body.toolCallId : null,
      reviewed_by: admin.email ?? admin.id,
      rating: typeof body.rating === 'string' ? body.rating : null,
      correct_tool: typeof body.correctTool === 'boolean' ? body.correctTool : null,
      wrong_tool: typeof body.wrongTool === 'boolean' ? body.wrongTool : null,
      insufficient_data: typeof body.insufficientData === 'boolean' ? body.insufficientData : null,
      bad_response: typeof body.badResponse === 'boolean' ? body.badResponse : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { evaluation: data };
}

function dashboardHtml(env: MeetingNoteEnv): string {
  const clientId = env.mcpAdminClientId ?? '';
  const tenantId = env.mcpAdminTenantId ?? 'common';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP Tracking</title>
  <script src="https://alcdn.msauth.net/browser/2.39.0/js/msal-browser.min.js"></script>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #f4f6fa;
      --panel: #ffffff;
      --ink: #151922;
      --muted: #657084;
      --line: #e2e7f0;
      --line-soft: #eef2f7;
      --blue: #2563eb;
      --green: #15803d;
      --red: #b42318;
      --amber: #b45309;
      --shadow: 0 12px 36px rgba(21, 25, 34, 0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 16px 24px;
      background: rgba(255, 255, 255, 0.94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(12px);
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 20px; font-weight: 720; }
    h2 { font-size: 15px; font-weight: 700; }
    h3 { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
    main { padding: 24px; display: grid; gap: 18px; max-width: 1480px; margin: 0 auto; }
    button {
      border: 1px solid #cfd6e4;
      background: #fff;
      border-radius: 7px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 650;
      color: #202635;
    }
    button.primary { background: var(--blue); border-color: var(--blue); color: white; }
    button.ghost { background: #f8fafc; }
    .brand { display: flex; flex-direction: column; gap: 3px; }
    .subtitle { color: var(--muted); font-size: 13px; }
    .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .account-pill {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #f8fafc;
      color: #344054;
      font-size: 13px;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; }
    .banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid #f4d48b;
      background: #fff7e6;
      color: #7a4b00;
      border-radius: 8px;
      font-size: 13px;
    }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr); gap: 18px; }
    .stack { display: grid; gap: 18px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .card.pad { padding: 16px; }
    .metric-card { padding: 15px; min-height: 118px; display: flex; flex-direction: column; justify-content: space-between; }
    .metric-label { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .metric { font-size: 30px; font-weight: 760; margin-top: 8px; }
    .metric-note { color: var(--muted); font-size: 12px; margin-top: 8px; }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line-soft);
    }
    .section-meta { color: var(--muted); font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
    th { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; background: #fbfcfe; }
    tbody tr:hover { background: #f8fbff; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 150px;
      overflow: auto;
      padding: 9px;
      border: 1px solid var(--line-soft);
      border-radius: 7px;
      background: #f8fafc;
      color: #263244;
      font-size: 12px;
      line-height: 1.4;
    }
    .muted { color: var(--muted); }
    .error { color: var(--red); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--line);
      background: #f8fafc;
    }
    .badge.ok { color: var(--green); background: #ecfdf3; border-color: #b7e4c7; }
    .badge.error { color: var(--red); background: #fef3f2; border-color: #fecdca; }
    .badge.warn { color: var(--amber); background: #fffbeb; border-color: #fde68a; }
    .bar-list { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: 120px 1fr 42px; gap: 10px; align-items: center; font-size: 13px; }
    .bar-track { height: 8px; border-radius: 999px; background: #eef2f7; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; background: var(--blue); }
    .empty { padding: 18px; color: var(--muted); text-align: center; }
    @media (max-width: 1100px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .layout { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { header { align-items: flex-start; flex-direction: column; } main { padding: 14px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>MCP Tracking</h1>
      <div class="subtitle">Tool usage, request health, and admin review for Meeting Note MCP</div>
    </div>
    <div class="actions">
      <span id="account" class="account-pill"><span class="dot"></span><span id="accountText"></span></span>
      <button id="login" class="primary">Sign in with Microsoft</button>
      <button id="refresh" class="ghost">Refresh</button>
    </div>
  </header>
  <main>
    <section class="grid" id="metrics"></section>
    <section class="layout">
      <div class="stack">
        <section class="card">
          <div class="section-title"><h2>Recent Tool Calls</h2><span class="section-meta">Latest 50 calls</span></div>
          <table><thead><tr><th>Time</th><th>Tool</th><th>Status</th><th>Duration</th><th>Arguments</th><th>Result Preview</th></tr></thead><tbody id="tools"></tbody></table>
        </section>
        <section class="card">
          <div class="section-title"><h2>Recent Sessions</h2><span class="section-meta">Request-level MCP activity</span></div>
          <table><thead><tr><th>Time</th><th>User</th><th>Platform</th><th>Status</th><th>Duration</th></tr></thead><tbody id="sessions"></tbody></table>
        </section>
      </div>
      <aside class="stack">
        <section class="card pad">
          <h3>Platform Mix</h3>
          <div id="platformBreakdown" class="bar-list" style="margin-top: 14px;"></div>
        </section>
        <section class="card pad">
          <h3>Top Tools</h3>
          <div id="toolBreakdown" class="bar-list" style="margin-top: 14px;"></div>
        </section>
      </aside>
    </section>
  </main>
  <script>
    const mockMode = new URLSearchParams(window.location.search).get("mock") === "1";
    const scopes = ["User.Read"];
    const msalConfig = { auth: { clientId: ${JSON.stringify(clientId)}, authority: "https://login.microsoftonline.com/${tenantId}", redirectUri: window.location.origin + "/admin" }, cache: { cacheLocation: "localStorage" } };
    const app = mockMode ? null : new msal.PublicClientApplication(msalConfig);
    let account = null;

    function nowMinus(minutes) {
      return new Date(Date.now() - minutes * 60 * 1000).toISOString();
    }
    function mockData() {
      const recentSessions = [
        { id: "s1", started_at: nowMinus(3), user_hash: "f2a91c0d22ab", platform: "chatgpt", status: "completed", duration_ms: 1830 },
        { id: "s2", started_at: nowMinus(12), user_hash: "aa08bd9120ef", platform: "claude", status: "completed", duration_ms: 2480 },
        { id: "s3", started_at: nowMinus(24), user_hash: "f2a91c0d22ab", platform: "chatgpt", status: "failed", duration_ms: 6120 },
        { id: "s4", started_at: nowMinus(41), user_hash: "871dd99f100c", platform: "mcp-inspector", status: "completed", duration_ms: 920 },
      ];
      const toolCalls = [
        {
          id: "t1",
          started_at: nowMinus(2),
          tool_name: "get_meeting_brief",
          is_error: false,
          duration_ms: 312,
          arguments_preview: { noteId: "note_84", includeAttachments: true },
          result_preview: "{\\n  \\"title\\": \\"June Architecture Review\\",\\n  \\"attachments\\": 2,\\n  \\"summary\\": \\"Discussion covered MCP logging, transcription reliability, and dashboard rollout.\\"\\n}",
        },
        {
          id: "t2",
          started_at: nowMinus(5),
          tool_name: "search_notes",
          is_error: false,
          duration_ms: 486,
          arguments_preview: { query: "AssemblyAI language detection", scope: "summary" },
          result_preview: "{\\n  \\"notes\\": [\\"Transcription Model Testing\\", \\"Language Toggle Planning\\"]\\n}",
        },
        {
          id: "t3",
          started_at: nowMinus(13),
          tool_name: "find_action_items",
          is_error: false,
          duration_ms: 901,
          arguments_preview: { projectId: "mcp", limit: 10 },
          result_preview: "{\\n  \\"actionItems\\": [\\"Deploy MCP tracking dashboard\\", \\"Review failed tool calls daily\\"]\\n}",
        },
        {
          id: "t4",
          started_at: nowMinus(24),
          tool_name: "get_attachment_context",
          is_error: true,
          duration_ms: 273,
          arguments_preview: { noteId: "missing-note" },
          result_preview: "Note not found: missing-note",
        },
      ];
      return {
        overview: {
          totals: {
            sessionsToday: 38,
            uniqueUsersToday: 9,
            toolCallsToday: 126,
            failedToolCallsToday: 4,
            averageToolDurationMs: 742,
          },
          platformCounts: { chatgpt: 24, claude: 9, "mcp-inspector": 5 },
          toolCounts: { get_meeting_brief: 34, search_notes: 28, find_action_items: 19, get_note_transcript: 14, get_project_timeline: 8 },
          recentSessions,
          recentTools: toolCalls,
        },
        tools: { toolCalls },
      };
    }
    function cell(value, className = "") {
      const td = document.createElement("td");
      if (className) td.className = className;
      if (value instanceof Node) td.appendChild(value); else td.textContent = value ?? "";
      return td;
    }
    function pre(value) {
      const node = document.createElement("pre");
      node.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return node;
    }
    async function token() {
      if (!app) throw new Error("Microsoft login is disabled in mock mode.");
      if (!account) throw new Error("Sign in first.");
      const result = await app.acquireTokenSilent({ account, scopes }).catch(() => app.acquireTokenPopup({ account, scopes }));
      return result.accessToken;
    }
    async function api(path) {
      if (mockMode) {
        const data = mockData();
        if (path.startsWith("/admin/api/tool-calls")) return data.tools;
        return data.overview;
      }
      const accessToken = await token();
      const response = await fetch(path, { headers: { authorization: "Bearer " + accessToken } });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    function badge(text, kind) {
      const node = document.createElement("span");
      node.className = "badge " + (kind || "");
      node.textContent = text;
      return node;
    }
    function renderBars(targetId, counts) {
      const target = document.getElementById(targetId);
      target.innerHTML = "";
      const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
      const max = Math.max(...entries.map(([, value]) => value), 1);
      if (!entries.length) {
        target.innerHTML = '<div class="empty">No data yet.</div>';
        return;
      }
      for (const [label, value] of entries.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "bar-row";
        row.innerHTML = '<span></span><div class="bar-track"><div class="bar-fill"></div></div><strong></strong>';
        row.children[0].textContent = label;
        row.querySelector(".bar-fill").style.width = Math.max(4, Math.round((value / max) * 100)) + "%";
        row.children[2].textContent = value;
        target.appendChild(row);
      }
    }
    function renderMetrics(totals, platformCounts, toolCounts) {
      const metrics = document.getElementById("metrics");
      metrics.innerHTML = "";
      const items = [
        ["Sessions Today", totals.sessionsToday, "Tracked MCP requests"],
        ["Unique Users", totals.uniqueUsersToday, "Users with activity today"],
        ["Tool Calls Today", totals.toolCallsToday, "Total tool executions"],
        ["Failed Tool Calls", totals.failedToolCallsToday, "Calls requiring review"],
        ["Avg Tool Duration", totals.averageToolDurationMs + " ms", "Across today's calls"],
      ];
      for (const [label, value, note] of items) {
        const card = document.createElement("div");
        card.className = "card metric-card";
        card.innerHTML = '<div><div class="metric-label"></div><div class="metric"></div></div><div class="metric-note"></div>';
        card.querySelector(".metric-label").textContent = label;
        card.querySelector(".metric").textContent = value;
        card.querySelector(".metric-note").textContent = note || "";
        metrics.appendChild(card);
      }
      renderBars("platformBreakdown", platformCounts);
      renderBars("toolBreakdown", toolCounts);
    }
    function renderSessions(rows) {
      const body = document.getElementById("sessions");
      body.innerHTML = "";
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No sessions yet.</td></tr>';
        return;
      }
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.append(cell(new Date(row.started_at).toLocaleString()));
        tr.append(cell(row.user_hash || ""));
        tr.append(cell(badge(row.platform || "unknown", "")));
        tr.append(cell(badge(row.status || "unknown", row.status === "failed" ? "error" : row.status === "completed" ? "ok" : "warn")));
        tr.append(cell(row.duration_ms ? row.duration_ms + " ms" : ""));
        body.appendChild(tr);
      }
    }
    function renderTools(rows) {
      const body = document.getElementById("tools");
      body.innerHTML = "";
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="empty">No tool calls yet.</td></tr>';
        return;
      }
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.append(cell(new Date(row.started_at).toLocaleString()));
        tr.append(cell(row.tool_name || ""));
        tr.append(cell(badge(row.is_error ? "Error" : "OK", row.is_error ? "error" : "ok")));
        tr.append(cell(row.duration_ms ? row.duration_ms + " ms" : ""));
        tr.append(cell(pre(row.arguments_preview)));
        tr.append(cell(pre(row.result_preview || "")));
        body.appendChild(tr);
      }
    }
    async function refresh() {
      const overview = await api("/admin/api/overview");
      const tools = await api("/admin/api/tool-calls?limit=50");
      renderMetrics(overview.totals, overview.platformCounts, overview.toolCounts);
      renderSessions(overview.recentSessions);
      renderTools(tools.toolCalls);
    }
    document.getElementById("login").onclick = async () => {
      if (!app) return;
      const result = await app.loginPopup({ scopes });
      account = result.account;
      document.getElementById("account").style.display = "inline-flex";
      document.getElementById("accountText").textContent = account?.username || "";
      await refresh();
    };
    document.getElementById("refresh").onclick = () => refresh().catch((error) => alert(error.message));
    if (mockMode) {
      document.getElementById("login").style.display = "none";
      refresh().catch((error) => console.error(error));
    } else if (app) {
      app.handleRedirectPromise().then(() => {
      account = app.getAllAccounts()[0] || null;
      if (account) {
        document.getElementById("account").style.display = "inline-flex";
        document.getElementById("accountText").textContent = account.username || "";
        refresh().catch((error) => console.error(error));
      }
      });
    }
  </script>
</body>
</html>`;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/admin')) return false;
  const env = getEnv();

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    sendHtml(res, dashboardHtml(env));
    return true;
  }

  if (url.pathname === '/admin/api/config') {
    sendJson(res, 200, {
      clientId: env.mcpAdminClientId,
      tenantId: env.mcpAdminTenantId,
    });
    return true;
  }

  const admin = await requireAdmin(req, env);
  if (!admin) {
    sendJson(res, 401, { error: 'Admin Microsoft login required.' });
    return true;
  }

  try {
    if (url.pathname === '/admin/api/overview') {
      sendJson(res, 200, await getOverview());
      return true;
    }
    if (url.pathname === '/admin/api/sessions') {
      sendJson(res, 200, await getSessions(url));
      return true;
    }
    if (url.pathname === '/admin/api/tool-calls') {
      sendJson(res, 200, await getToolCalls(url));
      return true;
    }
    if (url.pathname === '/admin/api/evaluations' && req.method === 'POST') {
      sendJson(res, 200, await saveEvaluation(req, admin));
      return true;
    }
    sendJson(res, 404, { error: 'Admin route not found.' });
    return true;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
