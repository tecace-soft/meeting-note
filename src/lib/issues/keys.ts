// F2: issue key, attachment path / display name, clipboard file extraction
// (spec sections 6.2, 6.3, 6.7).

/** FB-YYYYMMDD-XXXXXXXX: creator's local date + 8 uppercase hex (DATA-2). */
export const buildIssueKey = (now = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `FB-${ymd}-${rand}`;
};

/**
 * screenshots/{Date.now()}-{uuid}.{ext}; no extension means png (ATT-3). The spec's random7
 * part is a full crypto UUID here so paths cannot be guessed (security review 2026-10-15),
 * and the extension is reduced to [a-z0-9] so the path passes the server / DB whitelist
 * (^(screenshots|<uuid>)/[A-Za-z0-9._-]+$).
 */
export const buildPath = (file: { name: string }): string => {
  const raw = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'png';
  return `screenshots/${Date.now()}-${crypto.randomUUID()}.${ext}`;
};

/** A pasted clipboard image is named image.png; show it as 스크린샷-{n}.png. */
export const displayName = (file: { name: string }, index: number): string =>
  file.name && file.name !== 'image.png' ? file.name : `스크린샷-${index + 1}.png`;

/** ATT-1: files first, then file items (some browsers leave `files` empty on paste). */
export const extractFiles = (data: DataTransfer | null): File[] => {
  if (!data) return [];
  const direct = Array.from(data.files ?? []);
  if (direct.length > 0) return direct;
  return Array.from(data.items ?? [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
};
