import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, LogOut, Mail, Pencil, Save, Shield, User, UserCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SpeakerOntologyView } from '../components/SpeakerOntologyView';
import { supabase } from '../config/supabaseConfig';
import { findBestSpeakerRowForMsAccount } from '../lib/matchSpeakerIdentity';
import { canonicalOntologyProfileString, isOntologyProfile } from '../lib/speakerOntology';
import { DEFAULT_SUMMARY_PROMPT } from '../constants/defaultSummaryPrompt';

/** Supabase table name (exact identifier in your project). */
const SUMMARY_PROMPT_TABLE = 'summary_prompt';

type SettingsTab = 'account' | 'summary' | 'speaker';

const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  const [activeTab, setActiveTab] = useState<SettingsTab>('account');

  const [summaryPromptDraft, setSummaryPromptDraft] = useState('');
  const [summaryPromptLoading, setSummaryPromptLoading] = useState(false);
  const [summaryPromptSaving, setSummaryPromptSaving] = useState(false);
  const [summaryPromptError, setSummaryPromptError] = useState<string | null>(null);
  const [summaryPromptSaved, setSummaryPromptSaved] = useState(false);

  const [speakerSelfState, setSpeakerSelfState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; matched: { id: string; name: string; profile: string | null } | null }
  >({ status: 'idle' });

  const [speakerProfileEditing, setSpeakerProfileEditing] = useState(false);
  const [speakerProfileDraft, setSpeakerProfileDraft] = useState('');
  const [speakerProfileSaving, setSpeakerProfileSaving] = useState(false);
  const [speakerProfileSaveError, setSpeakerProfileSaveError] = useState<string | null>(null);
  const [speakerProfileSavedFlash, setSpeakerProfileSavedFlash] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  useEffect(() => {
    if (!user?.id || !isAuthenticated) return;
    let cancelled = false;

    const load = async () => {
      setSummaryPromptLoading(true);
      setSummaryPromptError(null);
      try {
        const { data, error } = await supabase
          .from(SUMMARY_PROMPT_TABLE)
          .select('prompt')
          .eq('user_id', user.id)
          .maybeSingle();

        if (cancelled) return;
        if (error) throw error;

        if (!data) {
          const { error: insertError } = await supabase.from(SUMMARY_PROMPT_TABLE).insert({
            user_id: user.id,
            prompt: DEFAULT_SUMMARY_PROMPT,
          });
          if (insertError) {
            const code = (insertError as { code?: string }).code;
            if (code === '23505') {
              const { data: rowAfterRace, error: fetchErr } = await supabase
                .from(SUMMARY_PROMPT_TABLE)
                .select('prompt')
                .eq('user_id', user.id)
                .maybeSingle();
              if (fetchErr) throw fetchErr;
              setSummaryPromptDraft(typeof rowAfterRace?.prompt === 'string' ? rowAfterRace.prompt : '');
            } else {
              throw insertError;
            }
          } else {
            setSummaryPromptDraft(DEFAULT_SUMMARY_PROMPT);
          }
        } else {
          setSummaryPromptDraft(typeof data.prompt === 'string' ? data.prompt : '');
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setSummaryPromptError(err instanceof Error ? err.message : 'Failed to load summary prompt');
        }
      } finally {
        if (!cancelled) setSummaryPromptLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isAuthenticated]);

  useEffect(() => {
    if (activeTab !== 'speaker' || !user?.id || !isAuthenticated) return;
    let cancelled = false;
    const load = async () => {
      setSpeakerSelfState({ status: 'loading' });
      try {
        const { data, error } = await supabase
          .from('speaker')
          .select('id, name, profile')
          .eq('user_id', user.id);
        if (cancelled) return;
        if (error) throw error;
        const rows = (data ?? []) as { id: string; name: string; profile: string | null }[];
        const matched = findBestSpeakerRowForMsAccount(rows, user.displayName ?? '');
        setSpeakerSelfState({ status: 'ready', matched });
      } catch (err: unknown) {
        if (!cancelled) {
          setSpeakerSelfState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load speaker profiles',
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeTab, user?.id, user?.displayName, isAuthenticated]);

  useEffect(() => {
    if (activeTab !== 'speaker') {
      setSpeakerProfileEditing(false);
      setSpeakerProfileSaveError(null);
    }
  }, [activeTab]);

  const handleSaveSpeakerProfile = useCallback(async () => {
    if (!user?.id) return;
    if (speakerSelfState.status !== 'ready' || !speakerSelfState.matched) return;
    setSpeakerProfileSaving(true);
    setSpeakerProfileSaveError(null);
    try {
      const toSave = canonicalOntologyProfileString(speakerProfileDraft);
      const { error } = await supabase
        .from('speaker')
        .update({ profile: toSave })
        .eq('id', speakerSelfState.matched.id)
        .eq('user_id', user.id);
      if (error) throw error;
      setSpeakerSelfState({
        status: 'ready',
        matched: { ...speakerSelfState.matched, profile: toSave },
      });
      setSpeakerProfileEditing(false);
      setSpeakerProfileSavedFlash(true);
      window.setTimeout(() => setSpeakerProfileSavedFlash(false), 2500);
    } catch (err: unknown) {
      setSpeakerProfileSaveError(err instanceof Error ? err.message : 'Failed to save speaker profile');
    } finally {
      setSpeakerProfileSaving(false);
    }
  }, [user?.id, speakerSelfState, speakerProfileDraft]);

  const handleSaveSummaryPrompt = useCallback(async () => {
    if (!user?.id) return;
    setSummaryPromptSaving(true);
    setSummaryPromptError(null);
    setSummaryPromptSaved(false);
    try {
      const { error: updateError } = await supabase
        .from(SUMMARY_PROMPT_TABLE)
        .update({ prompt: summaryPromptDraft })
        .eq('user_id', user.id);

      if (updateError) throw updateError;

      const { data: existing, error: readError } = await supabase
        .from(SUMMARY_PROMPT_TABLE)
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (readError) throw readError;

      if (!existing) {
        const { error: insertError } = await supabase.from(SUMMARY_PROMPT_TABLE).insert({
          user_id: user.id,
          prompt: summaryPromptDraft,
        });
        if (insertError) throw insertError;
      }

      setSummaryPromptSaved(true);
      window.setTimeout(() => setSummaryPromptSaved(false), 2500);
    } catch (err: unknown) {
      setSummaryPromptError(err instanceof Error ? err.message : 'Failed to save summary prompt');
    } finally {
      setSummaryPromptSaving(false);
    }
  }, [user?.id, summaryPromptDraft]);

  if (isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center" style={{ backgroundColor: 'var(--bg)' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Loading account...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
          <div>
            <h2 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
              Account Settings
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              Microsoft account details for your meeting notes workspace
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex flex-shrink-0 flex-wrap gap-2" role="tablist" aria-label="Settings sections">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'account'}
                id="settings-tab-account"
                aria-controls="settings-panel-account"
                onClick={() => setActiveTab('account')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'account'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                Account
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'summary'}
                id="settings-tab-summary"
                aria-controls="settings-panel-summary"
                onClick={() => setActiveTab('summary')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'summary'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                Summary prompt
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'speaker'}
                id="settings-tab-speaker"
                aria-controls="settings-panel-speaker"
                onClick={() => setActiveTab('speaker')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'speaker'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                Speaker Profile
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeTab === 'account' ? (
                <section
                  id="settings-panel-account"
                  role="tabpanel"
                  aria-labelledby="settings-tab-account"
                  className="card rounded-lg p-5"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      {user?.displayName?.charAt(0).toUpperCase() || 'U'}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold" style={{ color: 'var(--text)' }}>
                        {user?.displayName || 'User'}
                      </p>
                      <p className="truncate text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {user?.email || 'No email'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-3">
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                      <UserCircle className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Display name</p>
                        <p className="truncate text-sm" style={{ color: 'var(--text)' }}>{user?.displayName || 'User'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                      <Mail className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Email</p>
                        <p className="truncate text-sm" style={{ color: 'var(--text)' }}>{user?.email || 'No email'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                      <Shield className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Authentication</p>
                        <p className="text-sm" style={{ color: 'var(--text)' }}>Microsoft Entra ID (MSAL)</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex justify-end">
                    <button
                      type="button"
                      onClick={logout}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium"
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      <LogOut className="h-4 w-4" aria-hidden />
                      Sign Out
                    </button>
                  </div>
                </section>
              ) : null}

              {activeTab === 'summary' ? (
                <section
                  id="settings-panel-summary"
                  role="tabpanel"
                  aria-labelledby="settings-tab-summary"
                  className="card rounded-lg p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                        Summary prompt
                      </h3>
                      <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Default instructions sent with meeting summarization (stored per account).
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={summaryPromptSaving || summaryPromptLoading || !user?.id}
                      onClick={() => void handleSaveSummaryPrompt()}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      {summaryPromptSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Save className="h-4 w-4" aria-hidden />
                      )}
                      Save
                    </button>
                  </div>

                  {summaryPromptLoading ? (
                    <div className="mt-4 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
                      Loading prompt…
                    </div>
                  ) : (
                    <textarea
                      value={summaryPromptDraft}
                      onChange={(e) => setSummaryPromptDraft(e.target.value)}
                      className="custom-scrollbar mt-4 min-h-[18rem] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-[var(--accent)]"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text)',
                        borderColor: 'var(--border)',
                      }}
                      spellCheck={false}
                      aria-label="Summary prompt template"
                    />
                  )}

                  {summaryPromptError ? (
                    <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>
                      {summaryPromptError}
                    </p>
                  ) : null}
                  {summaryPromptSaved ? (
                    <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>
                      Saved.
                    </p>
                  ) : null}
                </section>
              ) : null}

              {activeTab === 'speaker' ? (
                <section
                  id="settings-panel-speaker"
                  role="tabpanel"
                  aria-labelledby="settings-tab-speaker"
                  className="card flex max-h-[min(78vh,36rem)] min-h-[10rem] flex-col overflow-hidden rounded-lg p-0"
                >
                  <div
                    className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-5 py-4"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="min-w-0 flex-1">
                      {speakerSelfState.status === 'loading' || speakerSelfState.status === 'idle' ? (
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                          Loading speaker data…
                        </div>
                      ) : null}
                      {speakerSelfState.status === 'error' ? (
                        <p className="text-sm" style={{ color: 'var(--error)' }}>
                          {speakerSelfState.message}
                        </p>
                      ) : null}
                      {speakerSelfState.status === 'ready' && !speakerSelfState.matched ? (
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          No saved speaker matched your account name. Names from transcripts (for example{' '}
                          <span className="font-mono text-xs">Gene</span> vs{' '}
                          <span className="font-mono text-xs">Gene Kim</span>) are compared to your Microsoft name after
                          removing alternate-script parentheses and punctuation. Label yourself in a transcript or add a
                          matching saved speaker, then try again.
                        </p>
                      ) : null}
                      {speakerSelfState.status === 'ready' && speakerSelfState.matched ? (
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold" style={{ color: 'var(--text)' }}>
                            {speakerSelfState.matched.name}
                          </p>
                          <p className="mt-0.5 truncate text-sm" style={{ color: 'var(--text-muted)' }}>
                            {user?.displayName ?? '—'}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {speakerSelfState.status === 'ready' && speakerSelfState.matched ? (
                      speakerProfileEditing ? (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={speakerProfileSaving}
                            onClick={() => {
                              const m =
                                speakerSelfState.status === 'ready' && speakerSelfState.matched
                                  ? speakerSelfState.matched
                                  : null;
                              if (m) {
                                const p = m.profile?.trim() || null;
                                if (p && isOntologyProfile(p)) {
                                  try {
                                    setSpeakerProfileDraft(JSON.stringify(JSON.parse(p), null, 2));
                                  } catch {
                                    setSpeakerProfileDraft(p);
                                  }
                                } else {
                                  setSpeakerProfileDraft(p ?? '');
                                }
                              }
                              setSpeakerProfileEditing(false);
                              setSpeakerProfileSaveError(null);
                            }}
                            className="rounded-lg px-3 py-2 text-sm transition-opacity disabled:opacity-50"
                            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={speakerProfileSaving || !user?.id}
                            onClick={() => void handleSaveSpeakerProfile()}
                            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                          >
                            {speakerProfileSaving ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            ) : (
                              <Save className="h-4 w-4" aria-hidden />
                            )}
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (speakerSelfState.status !== 'ready' || !speakerSelfState.matched) return;
                            const m = speakerSelfState.matched;
                            const p = m.profile?.trim() || null;
                            if (p && isOntologyProfile(p)) {
                              try {
                                setSpeakerProfileDraft(JSON.stringify(JSON.parse(p), null, 2));
                              } catch {
                                setSpeakerProfileDraft(p);
                              }
                            } else {
                              setSpeakerProfileDraft(p ?? '');
                            }
                            setSpeakerProfileSaveError(null);
                            setSpeakerProfileEditing(true);
                          }}
                          className="inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                          Edit profile
                        </button>
                      )
                    ) : null}
                  </div>

                  {speakerSelfState.status === 'ready' && speakerSelfState.matched ? (
                    <>
                      {speakerProfileSaveError ? (
                        <div className="shrink-0 px-5 pt-3">
                          <p className="text-sm" style={{ color: 'var(--error)' }}>
                            {speakerProfileSaveError}
                          </p>
                        </div>
                      ) : null}
                      {speakerProfileSavedFlash ? (
                        <div className="shrink-0 px-5 pt-3">
                          <p className="text-sm" style={{ color: 'var(--success)' }}>
                            Profile saved.
                          </p>
                        </div>
                      ) : null}

                      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
                        {speakerProfileEditing ? (
                          <textarea
                            value={speakerProfileDraft}
                            onChange={(e) => setSpeakerProfileDraft(e.target.value)}
                            className="custom-scrollbar min-h-[min(18rem,40vh)] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-[var(--accent)]"
                            style={{
                              backgroundColor: 'var(--bg-secondary)',
                              color: 'var(--text)',
                              borderColor: 'var(--border)',
                            }}
                            spellCheck={false}
                            aria-label="Speaker profile JSON"
                            placeholder="{}"
                          />
                        ) : speakerSelfState.matched.profile ? (
                          <SpeakerOntologyView raw={speakerSelfState.matched.profile} embedded />
                        ) : (
                          <div
                            className="flex flex-col items-center justify-center py-12 text-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <User className="mb-3 h-10 w-10 opacity-40" aria-hidden />
                            <p className="text-sm">No ontology profile stored for this speaker yet.</p>
                            <p className="mt-2 max-w-sm text-xs leading-relaxed">
                              Use <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Edit profile</span>{' '}
                              above to add JSON.
                            </p>
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AccountSettings;
