// Step-2 memory value surface: fetch the deterministic meeting briefing from the
// workflow-server for the records (기록) tab. The server assembles it with NO LLM from the
// user's own user_memory (durable context) + recent note_insight decisions/events (meeting-
// level, owner-free). Best-effort: any failure — including app-token mode with no Microsoft
// token — returns null so the section simply hides.

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

export interface BriefingMemoryItem {
  text: string;
  entities: string[];
  updatedAt: string;
}

export interface BriefingDecision {
  text: string;
  rationale: string;
}

export interface BriefingEvent {
  cause: string;
  effect: string;
}

export interface BriefingRecentNote {
  noteId: string;
  noteName: string;
  date: string;
  decisions: BriefingDecision[];
  events: BriefingEvent[];
}

export interface MeetingBriefing {
  memoryItems: BriefingMemoryItem[];
  recent: BriefingRecentNote[];
  generatedAt: string;
}

export async function fetchMeetingBriefing(
  getAccessToken: () => Promise<string | null>,
): Promise<MeetingBriefing | null> {
  if (!WORKFLOW_API_URL) return null;
  try {
    const token = await getAccessToken();
    if (!token) return null; // app-token mode / not signed in with Microsoft — hide the section.
    const res = await fetch(`${WORKFLOW_API_URL}/meeting-briefing`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MeetingBriefing> | null;
    if (!data) return null;
    return {
      memoryItems: Array.isArray(data.memoryItems) ? data.memoryItems : [],
      recent: Array.isArray(data.recent) ? data.recent : [],
      generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '',
    };
  } catch {
    return null; // best-effort: never block the records tab over a briefing fetch.
  }
}
