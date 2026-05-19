import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export interface MeetingNoteEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  meetingNoteUserId?: string;
  mcpApiKey?: string;
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
    port,
  };
}
