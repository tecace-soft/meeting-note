/**
 * Mobile / in-app browsers often block window.open popups. MSAL redirect flows
 * use a full navigation instead and work reliably on iOS Safari and Android Chrome.
 */
export function shouldUseRedirectInteraction(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return true;
  }
  // Tablets in desktop UA mode still benefit from redirect when touch-primary
  if (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1) {
    try {
      if (window.matchMedia('(max-width: 1024px)').matches) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
