/**
 * After upload, public CDN URLs can briefly 404 until the object is visible.
 * Poll HEAD until OK or fall back to a short delay (handles flaky CORS on HEAD).
 */
export async function ensurePublicStorageUrlReady(publicUrl: string): Promise<void> {
  const maxAttempts = 12;
  let delayMs = 80;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.6), 2500);
    }
    try {
      const res = await fetch(publicUrl, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
      if (res.ok) return;
    } catch {
      /* network / CORS — keep retrying */
    }
  }
  await new Promise((r) => setTimeout(r, 450));
}
