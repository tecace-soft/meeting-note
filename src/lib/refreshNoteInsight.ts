// F5.0: after a speaker is (re)named, ask the workflow server to re-extract this note's
// note_insight from the renamed diarization, so action owners and participants resolve to
// real names instead of the frozen generic "Speaker A/B" transcription. Insight-only —
// the server does NOT re-fold personal memory here (that needs a supersede design).
//
// Best-effort and debounced per note: bursts of edits coalesce into one refresh, and any
// failure is swallowed (the index also refreshes on the next summary regenerate).

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');
const DEBOUNCE_MS = 1500;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function refreshOnce(noteId: string, getAccessToken: () => Promise<string | null>): Promise<void> {
  try {
    const token = await getAccessToken();
    if (!token) return; // no Microsoft token (e.g. app-token mode) — skip; regenerate will reindex.
    await fetch(`${WORKFLOW_API_URL}/refresh-note-insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ noteId }),
    });
  } catch {
    // best-effort: never disrupt the editor over an index refresh.
  }
}

export function scheduleNoteInsightRefresh(
  noteId: string | null | undefined,
  getAccessToken: () => Promise<string | null>,
): void {
  if (!WORKFLOW_API_URL || !noteId) return;
  const existing = pendingTimers.get(noteId);
  if (existing) clearTimeout(existing);
  pendingTimers.set(
    noteId,
    setTimeout(() => {
      pendingTimers.delete(noteId);
      void refreshOnce(noteId, getAccessToken);
    }, DEBOUNCE_MS),
  );
}
