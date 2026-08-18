import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export interface MeetingNoteEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  meetingNoteUserId?: string;
  mcpApiKey?: string;
  mcpUserTokens: Map<string, string>;
  mcpPublicBaseUrl?: string;
  mcpOAuthResource?: string;
  mcpOAuthScope?: string;
  mcpAzureTenantId?: string;
  mcpAllowAnonChatgptFallback: boolean;
  mcpTokenPepper?: string;
  mcpAdminClientId?: string;
  mcpAdminTenantId?: string;
  mcpAdminEmails: Set<string>;
  mcpAdminMicrosoftIds: Set<string>;
  mcpHealthCheckIntervalMs: number;
  mcpHeartbeatLogIntervalMs: number;
  mcpDisconnectAlertThreshold: number;
  // IANA zone used to interpret bare YYYY-MM-DD date filters (e.g. get_notes_by_date).
  // The user base is in Korea, so a plain "2026-08-18" means that day in KST, not UTC.
  mcpDefaultTimeZone: string;
  port: number;
}

// Validate a configured IANA time zone, falling back to Asia/Seoul (the user base) when
// unset or unrecognized, so a typo can never make Intl throw deep inside a date query.
function resolveDefaultTimeZone(raw: string | undefined): string {
  const value = raw?.trim() || 'Asia/Seoul';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    console.warn(`[env] MCP_DEFAULT_TIME_ZONE="${value}" is not a valid IANA zone; falling back to Asia/Seoul.`);
    return 'Asia/Seoul';
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(moduleDir, '../../.env');
loadDotenv({ path: envPath, quiet: true });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseUserTokenMap(raw: string | undefined): Map<string, string> {
  const tokenMap = new Map<string, string>();
  const value = raw?.trim();
  if (!value) return tokenMap;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object');
    }

    Object.entries(parsed as Record<string, unknown>).forEach(([token, userId]) => {
      if (typeof userId === 'string' && token.trim() && userId.trim()) {
        tokenMap.set(token.trim(), userId.trim());
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP_USER_TOKENS JSON: ${message}`);
  }

  return tokenMap;
}

function parseSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function getEnv(): MeetingNoteEnv {
  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : 3000;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  const mcpHealthCheckIntervalMs = parsePositiveNumber(
    process.env.MCP_HEALTH_CHECK_INTERVAL_MS,
    60_000
  );
  const mcpHeartbeatLogIntervalMs = parsePositiveNumber(
    process.env.MCP_HEARTBEAT_LOG_INTERVAL_MS,
    300_000
  );
  const mcpDisconnectAlertThreshold = parsePositiveNumber(
    process.env.MCP_DISCONNECT_ALERT_THRESHOLD,
    5
  );

  return {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    meetingNoteUserId: process.env.MEETING_NOTE_USER_ID?.trim() || undefined,
    mcpApiKey: process.env.MCP_API_KEY?.trim() || undefined,
    mcpUserTokens: parseUserTokenMap(process.env.MCP_USER_TOKENS),
    mcpPublicBaseUrl: process.env.MCP_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || undefined,
    mcpOAuthResource: process.env.MCP_OAUTH_RESOURCE?.trim() || undefined,
    mcpOAuthScope: process.env.MCP_OAUTH_SCOPE?.trim() || undefined,
    mcpAzureTenantId: process.env.MCP_AZURE_TENANT_ID?.trim() || undefined,
    mcpAllowAnonChatgptFallback: process.env.MCP_ALLOW_ANON_CHATGPT_FALLBACK?.trim().toLowerCase() === 'true',
    mcpTokenPepper: process.env.MCP_TOKEN_PEPPER?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
    mcpAdminClientId: process.env.MCP_ADMIN_CLIENT_ID?.trim() || process.env.VITE_MSAL_CLIENT_ID?.trim() || undefined,
    mcpAdminTenantId: process.env.MCP_ADMIN_TENANT_ID?.trim() || process.env.MCP_AZURE_TENANT_ID?.trim() || 'common',
    mcpAdminEmails: parseSet(process.env.MCP_ADMIN_EMAILS),
    mcpAdminMicrosoftIds: parseSet(process.env.MCP_ADMIN_MICROSOFT_IDS),
    mcpHealthCheckIntervalMs,
    mcpHeartbeatLogIntervalMs,
    mcpDisconnectAlertThreshold,
    mcpDefaultTimeZone: resolveDefaultTimeZone(process.env.MCP_DEFAULT_TIME_ZONE),
    port,
  };
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw?.trim() ? Number(raw.trim()) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
