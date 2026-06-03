import React, { useEffect, useMemo, useState } from 'react';
import { AddPlus, CloseMd, Loading, Save, Settings } from 'react-coolicons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { isAdminMicrosoftUser } from '../lib/adminAccess';

interface CustomSpellingDraft {
  from: string;
  to: string;
}

interface AdminControlsResponse {
  speechModel?: string;
  keytermsPrompt?: string[];
  customSpelling?: Array<{ from?: string[]; to?: string }>;
  summaryContext?: string;
  updatedBy?: string | null;
  updatedAt?: string | null;
  error?: string;
}

type AdminControlsTab = 'transcription' | 'summary';

const AdminControls: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const [speechModel, setSpeechModel] = useState('universal-3-pro');
  const [keytermsText, setKeytermsText] = useState('');
  const [customSpelling, setCustomSpelling] = useState<CustomSpellingDraft[]>([]);
  const [summaryContext, setSummaryContext] = useState('');
  const [activeTab, setActiveTab] = useState<AdminControlsTab>('transcription');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isAdmin = isAdminMicrosoftUser(user?.id);

  const keyterms = useMemo(() => (
    keytermsText
      .split('\n')
      .map((term) => term.trim())
      .filter(Boolean)
  ), [keytermsText]);

  useEffect(() => {
    if (!isLoading && (!isAuthenticated || !isAdmin)) {
      navigate('/');
    }
  }, [isAdmin, isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    if (!isAuthenticated || !isAdmin) return;
    let cancelled = false;

    const loadSettings = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Could not acquire Microsoft access token.');
        const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/admin-controls`, {
          method: 'GET',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            'x-ms-access-token': token,
          },
        });
        const payload = await response.json().catch(() => ({})) as AdminControlsResponse;
        if (!response.ok) throw new Error(payload.error || `Admin controls request failed (${response.status}).`);
        if (cancelled) return;
        setSpeechModel(payload.speechModel || 'universal-3-pro');
        setKeytermsText((payload.keytermsPrompt || []).join('\n'));
        setCustomSpelling((payload.customSpelling || []).map((rule) => ({
          from: Array.isArray(rule.from) ? rule.from.join(', ') : '',
          to: typeof rule.to === 'string' ? rule.to : '',
        })));
        setSummaryContext(typeof payload.summaryContext === 'string' ? payload.summaryContext : '');
        setUpdatedAt(payload.updatedAt ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load admin controls.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, isAdmin, isAuthenticated]);

  const saveSettings = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Could not acquire Microsoft access token.');
      const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/admin-controls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'x-ms-access-token': token,
        },
        body: JSON.stringify({
          speechModel,
          keytermsPrompt: keyterms,
          summaryContext,
          customSpelling: customSpelling.map((rule) => ({
            from: rule.from.split(',').map((entry) => entry.trim()).filter(Boolean),
            to: rule.to.trim(),
          })).filter((rule) => rule.from.length > 0 && rule.to),
        }),
      });
      const payload = await response.json().catch(() => ({})) as AdminControlsResponse;
      if (!response.ok) throw new Error(payload.error || `Admin controls save failed (${response.status}).`);
      setSpeechModel(payload.speechModel || speechModel);
      setKeytermsText((payload.keytermsPrompt || keyterms).join('\n'));
      setCustomSpelling((payload.customSpelling || []).map((rule) => ({
        from: Array.isArray(rule.from) ? rule.from.join(', ') : '',
        to: typeof rule.to === 'string' ? rule.to : '',
      })));
      setSummaryContext(typeof payload.summaryContext === 'string' ? payload.summaryContext : summaryContext);
      setUpdatedAt(payload.updatedAt ?? new Date().toISOString());
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save admin controls.');
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <Loading className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <div className="app-page-header">
            <div className="app-page-title-with-icon">
              <Settings className="app-page-title-icon" aria-hidden />
              <h1 className="app-page-title">Admin Controls</h1>
            </div>
            <p className="app-page-subtitle">
              Global transcription and summary-generation settings for all app users.
            </p>
          </div>

          <div className="flex flex-shrink-0 flex-wrap gap-2" role="tablist" aria-label="Admin control sections">
            {([
              ['transcription', 'Transcription Controls'],
              ['summary', 'Summary Controls'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                id={`admin-controls-tab-${tab}`}
                aria-controls={`admin-controls-panel-${tab}`}
                onClick={() => setActiveTab(tab)}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === tab
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--error-light)', color: 'var(--error)' }}>
              {error}
            </div>
          ) : null}
          {saved ? (
            <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--success-light)', color: 'var(--success)' }}>
              Transcription settings saved.
            </div>
          ) : null}

          {activeTab === 'transcription' ? (
            <>
              <section
                id="admin-controls-panel-transcription"
                role="tabpanel"
                aria-labelledby="admin-controls-tab-transcription"
                className="card rounded-lg p-4"
              >
                <label className="mb-2 block text-sm font-semibold" style={{ color: 'var(--text)' }}>
                  Speech model
                </label>
                <select
                  value={speechModel}
                  onChange={(event) => setSpeechModel(event.target.value)}
                  className="h-10 w-full rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] sm:max-w-sm"
                  style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
                >
                  <option value="universal-3-pro">Universal 3 Pro</option>
                  <option value="universal-2">Universal 2</option>
                </select>
              </section>

              <section className="card rounded-lg p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                    Keyterms prompt
                  </label>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{keyterms.length} terms</span>
                </div>
                <textarea
                  value={keytermsText}
                  onChange={(event) => setKeytermsText(event.target.value)}
                  rows={10}
                  placeholder="One key term per line, e.g. TecAce, AX Pro, Hansoo Lee"
                  className="w-full resize-y rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </section>

              <section className="card rounded-lg p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Custom spelling</h2>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Comma-separate possible heard forms, then set the desired spelling.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCustomSpelling((prev) => [...prev, { from: '', to: '' }])}
                    className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium"
                    style={{ backgroundColor: 'var(--accent-light)', color: 'var(--accent)' }}
                  >
                    <AddPlus className="h-4 w-4" />
                    Add
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {customSpelling.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-sm" style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}>
                      No custom spelling rules yet.
                    </p>
                  ) : customSpelling.map((rule, index) => (
                    <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.5fr)_auto]">
                      <input
                        value={rule.from}
                        onChange={(event) => setCustomSpelling((prev) => prev.map((item, i) => i === index ? { ...item, from: event.target.value } : item))}
                        placeholder="Heard as: tech ace, tek ace"
                        className="h-10 min-w-0 rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                        style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
                      />
                      <input
                        value={rule.to}
                        onChange={(event) => setCustomSpelling((prev) => prev.map((item, i) => i === index ? { ...item, to: event.target.value } : item))}
                        placeholder="Spell as: TecAce"
                        className="h-10 min-w-0 rounded-lg px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                        style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
                      />
                      <button
                        type="button"
                        onClick={() => setCustomSpelling((prev) => prev.filter((_, i) => i !== index))}
                        className="flex h-10 w-10 items-center justify-center rounded-lg"
                        style={{ color: 'var(--text-muted)' }}
                        aria-label="Remove custom spelling rule"
                      >
                        <CloseMd className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <section
              id="admin-controls-panel-summary"
              role="tabpanel"
              aria-labelledby="admin-controls-tab-summary"
              className="card rounded-lg p-4"
            >
              <label className="mb-2 block text-sm font-semibold" style={{ color: 'var(--text)' }}>
                Global summary context
              </label>
              <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                This context is injected into every Gemini summary request. Use it for company background, preferred terminology,
                recurring product names, and formatting preferences. It cannot override the transcript.
              </p>
              <textarea
                value={summaryContext}
                onChange={(event) => setSummaryContext(event.target.value)}
                rows={16}
                placeholder="Example: TecAce is a technology consulting company. Prefer concise executive summaries. AX Pro refers to..."
                className="w-full resize-y rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </section>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleString()}` : 'Not updated yet'}
            </p>
            <button
              type="button"
              onClick={() => void saveSettings()}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium disabled:opacity-60"
              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
            >
              {saving ? <Loading className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save settings
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AdminControls;
