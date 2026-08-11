// Small shared helpers for the eval harness.

/** Normalize a string for deterministic comparison (trim, lowercase, collapse space). */
export function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Race a promise against a timeout so a hung I/O call cannot stall the whole eval
 * (Power-of-Ten rule 2 — every I/O call has a failure path). Rejects on timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Strip a ```json ... ``` fence if the model wrapped its JSON. */
export function stripFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
