import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { MicrosoftIdentityError } from '../microsoftIdentity.js';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function corsHeaders(): Record<string, string> {
  const allowedOrigin = env.frontendOrigin === '*'
    ? '*'
    : env.frontendOrigin
        .split(',')
        .map(normalizeOrigin)
        .filter(Boolean)[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(body));
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, corsHeaders());
  res.end();
}

export function readBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function getHttpStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof MicrosoftIdentityError) return error.status;
  const message = errorMessage(error);
  if (message.includes('Missing bearer token') || message.includes('Microsoft Graph /me rejected')) return 401;
  if (message.includes('too large') || message.includes('exceeds')) return 413;
  if (message.includes('required') || message.includes('must be') || message.includes('Unsupported') || message.includes('token') || message.includes('userId')) return 400;
  return 500;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'details', 'hint', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function requiredString(body: object, key: string): string {
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new Error(`${String(key)} is required. Received fields: ${Object.keys(body).sort().join(', ') || 'none'}.`);
  }
  throw new Error(`${String(key)} must be a string or number. Received ${typeof value}.`);
}

export function getBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token.');
  return header.slice('Bearer '.length).trim();
}
