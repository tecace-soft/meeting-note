import { logError, logEvent } from './logger.js';

interface McpAlertInput {
  title: string;
  severity?: 'info' | 'warning' | 'critical';
  message?: string;
  error?: unknown;
  context?: Record<string, unknown>;
  dedupeKey?: string;
}

const sentAtByKey = new Map<string, number>();

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function alertCooldownMs(): number {
  const raw = envValue('MCP_ALERT_COOLDOWN_MS');
  const parsed = raw ? Number(raw) : 15 * 60 * 1000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function buildText(input: McpAlertInput): string {
  const payload = {
    service: 'meeting-note-mcp',
    environment: envValue('NODE_ENV') ?? envValue('RENDER_SERVICE_NAME') ?? 'unknown',
    renderService: envValue('RENDER_SERVICE_NAME'),
    renderInstance: envValue('RENDER_INSTANCE_ID'),
    severity: input.severity ?? 'warning',
    title: input.title,
    message: input.message,
    error: serializeError(input.error),
    context: input.context ?? {},
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(payload, null, 2);
}

export async function sendMcpAlert(input: McpAlertInput): Promise<void> {
  const apiKey = envValue('RESEND_API_KEY') ?? envValue('MCP_ALERT_RESEND_API_KEY');
  const to = envValue('MCP_ALERT_TO') ?? envValue('WORKFLOW_ALERT_TO');
  const from = envValue('MCP_ALERT_FROM') ?? envValue('WORKFLOW_ALERT_FROM') ?? 'Meeting Note MCP Alerts <onboarding@resend.dev>';

  if (!apiKey || !to) {
    logEvent('warn', 'mcp_alert_not_configured', {
      title: input.title,
      hasApiKey: Boolean(apiKey),
      hasRecipient: Boolean(to),
    });
    return;
  }

  const dedupeKey = input.dedupeKey ?? input.title;
  const now = Date.now();
  const lastSentAt = sentAtByKey.get(dedupeKey) ?? 0;
  if (now - lastSentAt < alertCooldownMs()) {
    logEvent('warn', 'mcp_alert_suppressed_by_cooldown', {
      title: input.title,
      dedupeKey,
      cooldownMs: alertCooldownMs(),
    });
    return;
  }
  sentAtByKey.set(dedupeKey, now);

  const subjectPrefix = input.severity === 'critical' ? '[CRITICAL]' : input.severity === 'info' ? '[INFO]' : '[WARN]';
  const body = {
    from,
    to: to.split(',').map((recipient) => recipient.trim()).filter(Boolean),
    subject: `${subjectPrefix} Meeting Note MCP: ${input.title}`,
    text: buildText(input),
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend email failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    logEvent('info', 'mcp_alert_sent', {
      title: input.title,
      severity: input.severity ?? 'warning',
      dedupeKey,
    });
  } catch (error) {
    logError('mcp_alert_send_failed', error, {
      title: input.title,
      dedupeKey,
    });
  }
}
