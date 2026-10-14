import { describe, expect, it, vi } from 'vitest';
import { saveFileRecordWithRetry, withTimeout } from './saveFileRecord';

const noSleep = () => Promise.resolve();

describe('saveFileRecordWithRetry', () => {
  it('saves on the first attempt', async () => {
    const insert = vi.fn().mockResolvedValue('f1');
    const r = await saveFileRecordWithRetry({ findExisting: async () => null, insert, sleep: noSleep });
    expect(r).toEqual({ status: 'saved', id: 'f1', attempts: 1 });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure then succeeds', async () => {
    const insert = vi.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValue('f2');
    const sleep = vi.fn(noSleep);
    const r = await saveFileRecordWithRetry({ findExisting: async () => null, insert, sleep });
    expect(r).toEqual({ status: 'saved', id: 'f2', attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('returns failed (never throws) after all attempts', async () => {
    const err = new Error('rls');
    const insert = vi.fn().mockRejectedValue(err);
    const r = await saveFileRecordWithRetry({ findExisting: async () => null, insert, sleep: noSleep });
    expect(r).toEqual({ status: 'failed', error: err, attempts: 3 });
    expect(insert).toHaveBeenCalledTimes(3);
  });

  it('reuses an existing row without inserting', async () => {
    const insert = vi.fn();
    const r = await saveFileRecordWithRetry({ findExisting: async () => 'old', insert, sleep: noSleep });
    expect(r).toEqual({ status: 'reused', id: 'old', attempts: 1 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('reuses the row when a previous insert succeeded but the response was lost', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('landed');
    const insert = vi.fn().mockRejectedValue(new Error('lost response'));
    const r = await saveFileRecordWithRetry({ findExisting: find, insert, sleep: noSleep });
    expect(r).toEqual({ status: 'reused', id: 'landed', attempts: 2 });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('treats a hung request as a timeout failure', async () => {
    const hang = () => new Promise<string | null>(() => {});
    const r = await saveFileRecordWithRetry({
      findExisting: async () => null,
      insert: hang,
      sleep: noSleep,
      attemptTimeoutMs: 5,
      maxAttempts: 2,
    });
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(2);
    if (r.status === 'failed') expect((r.error as Error).message).toMatch(/timed out/);
  });
});

describe('withTimeout', () => {
  it('passes through a fast result', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
});
