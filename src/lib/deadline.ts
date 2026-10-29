/**
 * Settle with `promise`, or reject with `message` after `ms`. The timer is always cleared.
 * Use it to bound a whole multi-step operation (token, reads, network) so a step that ignores
 * its abort signal can never leave the UI loading forever.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}
