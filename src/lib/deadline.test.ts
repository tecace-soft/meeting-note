import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineError, withDeadline } from './deadline';

afterEach(() => vi.useRealTimers());

describe('withDeadline', () => {
  it('passes a value through and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(7), 1000, 'late')).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes an error through', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'late')).rejects.toThrow('boom');
  });

  it('rejects a promise that never settles', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<never>(() => undefined), 1000, 'Took too long.');
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    await expect(pending).rejects.toThrow('Took too long.');
  });
});
