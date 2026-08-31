type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFields = Record<string, unknown>;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const payload: LogFields = {
    ts: new Date().toISOString(),
    level,
    service: 'meeting-note-mcp',
    event,
    ...fields,
  };

  const line = `${JSON.stringify(payload)}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  logEvent('error', event, {
    ...fields,
    error: serializeError(error),
  });
}
