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
  port: number;
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

export function getEnv(): MeetingNoteEnv {
  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : 3000;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  return {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    meetingNoteUserId: process.env.MEETING_NOTE_USER_ID?.trim() || undefined,
    mcpApiKey: process.env.MCP_API_KEY?.trim() || undefined,
    mcpUserTokens: parseUserTokenMap(process.env.MCP_USER_TOKENS),
    mcpPublicBaseUrl: process.env.MCP_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || undefined,
    port,
  };
}
