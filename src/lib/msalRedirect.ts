/**
 * Mobile / in-app browsers often block window.open popups. MSAL redirect flows
 * use a full navigation instead and work reliably on iOS Safari and Android Chrome.
 *
 * On desktop the redirect flow triggers a full page reload that destroys all
 * in-progress state (including an active recording), so it must be reserved for
 * genuinely touch-primary devices. Classification is by input capability
 * (pointer / hover), never by viewport size: a touch-capable laptop on a small
 * or projector-resolution display keeps the popup flow.
 */
export function shouldUseRedirectInteraction(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return true;
  }
  // iPadOS 13+ reports a desktop Safari (Macintosh) UA; a Mac UA with touch
  // points is really a touch-primary iPad.
  if (ua.includes('Macintosh') && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1) {
    return true;
  }
  // Otherwise redirect only when the primary pointer is coarse AND the device
  // cannot hover (phones/tablets with no mouse). A touch laptop has a fine
  // pointer and can hover, so it keeps the popup flow regardless of window size.
  try {
    return (
      window.matchMedia('(pointer: coarse)').matches &&
      window.matchMedia('(hover: none)').matches
    );
  } catch {
    return false;
  }
}
