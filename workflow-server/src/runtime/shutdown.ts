import type { Server } from 'node:http';
import { beginDrain, interruptExecutions, outsideExecution } from './executionScope.js';
import { jobLeases } from '../jobs/lease.js';

// Andrew confirmed Render's grace is at least 30 s on 2026-10-29.
export const SHUTDOWN_DEADLINE_MS = 20_000;
export function createGracefulStop(options: {
  server: Server;
  stopWorkers: () => void;
  cleanup: () => void;
  closeDispatcher: () => Promise<unknown>;
  destroyDispatcher: () => Promise<unknown>;
  deadlineMs?: number;
}): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    if (stopping) return stopping;
    beginDrain();
    options.stopWorkers();
    const executions = interruptExecutions();
    stopping = new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        options.cleanup();
        resolve();
      };
      const deadline = setTimeout(() => {
        options.server.closeAllConnections();
        options.server.close();
        void options.destroyDispatcher().catch(() => undefined);
        finish();
      }, options.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
      void outsideExecution(async () => {
        // Cancellation prevents further writes; these RPCs must run outside that scope.
        // Unknown DB outcomes retain S10's expiring durable lease, never a failed recording.
        await Promise.allSettled(executions.map(async (execution) => {
          if (typeof execution === 'string') return;
          const outcome = await jobLeases.release(execution);
          if (outcome !== 'ok' && outcome !== 'lost') console.warn('Shutdown lease handoff was not confirmed; S10 expiry remains the recovery path.');
        }));
        await new Promise<void>((closed) => {
          options.server.close(() => closed());
          options.server.closeIdleConnections();
        });
        await options.closeDispatcher();
      }).catch(() => console.warn('Shutdown cleanup did not finish; S10 durable state is retained.'))
        .finally(() => { clearTimeout(deadline); finish(); });
    });
    return stopping;
  };
}
