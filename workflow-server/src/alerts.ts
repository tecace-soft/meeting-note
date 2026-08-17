interface AlertConfig {
  enabled: boolean;
  resendApiKey: string;
  from: string;
  to: string;
  appName: string;
  environment: string;
}

export interface WorkflowAlertInput {
  title: string;
  error: unknown;
  severity?: 'error' | 'warning';
  context?: Record<string, unknown>;
}

const MAX_FIELD_LENGTH = 2000;

const config: AlertConfig = {
  enabled: (process.env.WORKFLOW_ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false',
  resendApiKey: process.env.RESEND_API_KEY ?? process.env.WORKFLOW_ALERT_RESEND_API_KEY ?? '',
  from: process.env.WORKFLOW_ALERT_FROM ?? 'Meeting Note Alerts <onboarding@resend.dev>',
  to: process.env.WORKFLOW_ALERT_TO ?? 'genekim@tecace.com,andrewyoo@tecace.com',
  appName: process.env.WORKFLOW_ALERT_APP_NAME ?? 'Meeting Note Workflow Server',
  environment: process.env.NODE_ENV ?? process.env.RENDER_SERVICE_NAME ?? 'development',
};

function truncate(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...` : value;
}

/** Split a comma-separated recipient list into a deduped array of addresses. */
function parseRecipients(value: string): string[] {
  const seen = new Set<string>();
  for (const address of value.split(',')) {
    const trimmed = address.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export function formatError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: truncate(error.stack ?? ''),
      cause: truncate(String((error as Error & { cause?: unknown }).cause ?? '')),
    };
  }
  return {
    name: typeof error,
    message: truncate(String(error)),
    stack: '',
    cause: '',
  };
}

export function sanitizeContext(context: Record<string, unknown> = {}): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (/token|authorization|apikey|api_key|secret|password/i.test(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      sanitized[key] = truncate(value);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function buildText(input: WorkflowAlertInput, errorFields: Record<string, string>, context: Record<string, unknown>): string {
  return [
    `${config.appName} alert`,
    '',
    `Title: ${input.title}`,
    `Severity: ${input.severity ?? 'error'}`,
    `Environment: ${config.environment}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'Error:',
    JSON.stringify(errorFields, null, 2),
    '',
    'Context:',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

/** Default ops recipients (WORKFLOW_ALERT_TO) — used as the "operations" inbox. */
export function alertRecipients(): string[] {
  return parseRecipients(config.to);
}

/** Generic transactional send via the same Resend plumbing. Returns false on skip/failure. */
export async function sendEmail(input: { to: string[]; subject: string; html?: string; text?: string }): Promise<boolean> {
  if (!config.enabled) return false;
  if (!config.resendApiKey) {
    console.warn('sendEmail skipped: RESEND_API_KEY is not configured.');
    return false;
  }
  const to = input.to.map((a) => a.trim()).filter(Boolean);
  if (to.length === 0) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to,
        subject: input.subject,
        ...(input.html ? { html: input.html } : {}),
        ...(input.text ? { text: input.text } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(`sendEmail failed (${response.status}): ${detail.slice(0, 500)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('sendEmail failed:', error);
    return false;
  }
}

export async function sendWorkflowAlert(input: WorkflowAlertInput): Promise<void> {
  if (!config.enabled) return;
  if (!config.resendApiKey) {
    console.warn('Workflow alert skipped: RESEND_API_KEY or WORKFLOW_ALERT_RESEND_API_KEY is not configured.');
    return;
  }

  const recipients = parseRecipients(config.to);
  if (recipients.length === 0) {
    console.warn('Workflow alert skipped: WORKFLOW_ALERT_TO resolved to no valid recipients.');
    return;
  }

  const errorFields = formatError(input.error);
  const context = sanitizeContext(input.context);
  const subject = `[${config.appName}] ${input.title}`;
  const text = buildText(input, errorFields, context);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: recipients,
        subject,
        text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(`Workflow alert email failed (${response.status}): ${detail.slice(0, 500)}`);
    }
  } catch (error) {
    console.warn('Workflow alert email failed:', error);
  }
}
