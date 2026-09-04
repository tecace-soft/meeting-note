import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { fetchMeetingBriefing, type MeetingBriefing as Briefing } from '../lib/meetingBriefing';

// Step-2 memory value surface. A read-only briefing at the top of the records (기록) tab,
// assembled server-side with NO LLM from the user's own memory + recent meeting-level
// decisions/events. It deliberately shows NO action items / owner attribution (those depend
// on speaker-ID, which is measured-unreliable). Self-hides when empty, still loading, or
// unavailable (e.g. app-token mode with no Microsoft token), so it never clutters the tab.

interface Props {
  getAccessToken: () => Promise<string | null>;
}

const COLLAPSE_KEY = 'meeting-note:briefing-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

// Memory items today can be long multi-clause run-ons (a known memory-quality debt: the
// old consolidation concatenated subjects). The briefing is a glance surface, so we show a
// short preview here — the first semicolon clause when it is substantial, otherwise a capped
// slice — while the full text stays in the "My Memory" screen and on hover (title attr).
function memoryPreview(text: string, max = 180): string {
  const clause = text.split(';')[0].trim();
  const chosen = clause.length >= 30 ? clause : text;
  return chosen.length > max ? `${chosen.slice(0, max).replace(/[\s,;.]+$/, '')}…` : chosen;
}

function formatDate(iso: string, ko: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(ko ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

export function MeetingBriefing({ getAccessToken }: Props): JSX.Element | null {
  const { appLanguage } = useLanguage();
  const ko = appLanguage === 'ko';
  const [data, setData] = useState<Briefing | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  const load = useCallback(async () => {
    const result = await fetchMeetingBriefing(getAccessToken);
    setData(result);
    setLoaded(true);
  }, [getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore: collapse state is a convenience only.
      }
      return next;
    });
  }, []);

  // Hide entirely until we know there is something worth showing.
  if (!loaded || !data) return null;
  const hasMemory = data.memoryItems.length > 0;
  const hasRecent = data.recent.length > 0;
  if (!hasMemory && !hasRecent) return null;

  return (
    <section
      className="card rounded-lg border p-4 sm:p-5"
      style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            {ko ? '브리핑' : 'Briefing'}
          </h3>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {ko
              ? '내 메모리와 최근 회의에서 자동으로 모은 맥락입니다.'
              : 'Context gathered automatically from your memory and recent meetings.'}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium"
          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
        >
          {collapsed ? (ko ? '펼치기' : 'Show') : ko ? '접기' : 'Hide'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          {hasMemory ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {ko ? '진행 중인 맥락' : 'Ongoing context'}
              </h4>
              <ul className="mt-2.5 space-y-2 pl-4" style={{ listStyleType: 'disc' }}>
                {data.memoryItems.map((item, i) => (
                  <li key={`mem-${i}`} className="text-sm leading-relaxed" style={{ color: 'var(--text)' }} title={item.text}>
                    {memoryPreview(item.text)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hasRecent ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {ko ? '최근 결정·이벤트' : 'Recent decisions & events'}
              </h4>
              <div className="mt-2.5 space-y-3.5">
                {data.recent.map((note) => (
                  <div key={note.noteId}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                        {note.noteName}
                      </span>
                      {formatDate(note.date, ko) ? (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {formatDate(note.date, ko)}
                        </span>
                      ) : null}
                    </div>
                    <ul className="mt-1.5 space-y-1.5 pl-4" style={{ listStyleType: 'disc' }}>
                      {note.decisions.map((d, i) => (
                        <li key={`d-${i}`} className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
                          {d.text}
                          {d.rationale ? (
                            <span style={{ color: 'var(--text-muted)' }}> {ko ? '— 이유: ' : '— why: '}{d.rationale}</span>
                          ) : null}
                        </li>
                      ))}
                      {note.events.map((e, i) => (
                        <li key={`e-${i}`} className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
                          {e.cause && e.effect ? `${e.cause} → ${e.effect}` : e.effect || e.cause}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
