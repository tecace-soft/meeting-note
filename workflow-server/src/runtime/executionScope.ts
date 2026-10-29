// Process-local cancellation only. Durable authority always comes from the SQL fence.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobExecution } from '../jobs/lease.js';

const signals = new AsyncLocalStorage<AbortSignal | undefined>();
let draining = false;
export const isDraining = () => draining;
export const beginDrain = () => { draining = true; };
export const resetDrain = () => { draining = false; };
export const executionSignal = () => signals.getStore();
export const outsideExecution = <T>(run: () => T): T => signals.run(undefined, run);

export class ServerDrainingError extends Error {
  constructor() { super('Server is shutting down. Please retry.'); this.name = 'ServerDrainingError'; }
}
export function assertExecutionActive(): void {
  executionSignal()?.throwIfAborted();
}
export async function executionDelay(ms: number): Promise<void> {
  const signal = executionSignal();
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clean = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { clean(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); clean(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function executionFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const active = executionSignal();
  active?.throwIfAborted();
  if (!active) return globalThis.fetch(input, init);
  const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return globalThis.fetch(input, { ...init, signal: original ? AbortSignal.any([active, original]) : active });
}

interface RunningExecution {
  job: string | JobExecution;
  controller: AbortController;
  stopHeartbeat: () => void;
}
const running = new Set<RunningExecution>();
export function registerExecution(job: string | JobExecution, stopHeartbeat: () => void) {
  if (draining) { stopHeartbeat(); throw new ServerDrainingError(); }
  const entry = { job, stopHeartbeat, controller: new AbortController() };
  running.add(entry);
  return {
    run: <T>(operation: () => T): T => signals.run(entry.controller.signal, operation),
    finish: () => { stopHeartbeat(); running.delete(entry); },
  };
}
export function interruptExecutions(): Array<string | JobExecution> {
  const entries = [...running];
  for (const entry of entries) {
    entry.stopHeartbeat();
    if (typeof entry.job !== 'string') entry.job.lost = true;
    entry.controller.abort(new ServerDrainingError());
  }
  return entries.map((entry) => entry.job);
}
