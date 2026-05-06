import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Loader2, Pencil, Save, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SpeakerOntologyView } from '../components/SpeakerOntologyView';
import { supabase } from '../config/supabaseConfig';
import { findBestSpeakerRowForMsAccount } from '../lib/matchSpeakerIdentity';
import { canonicalOntologyProfileString, isOntologyProfile } from '../lib/speakerOntology';
import { DEFAULT_SUMMARY_PROMPT } from '../constants/defaultSummaryPrompt';

/** Supabase table name (exact identifier in your project). */
const SUMMARY_PROMPT_TABLE = 'summary_prompt';

type SettingsTab = 'account' | 'summary' | 'speaker';

type SpeakerRow = { id: string; name: string; profile: string | null };

type SpeakersLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: SpeakerRow[] };

const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading } = useAuth();

  const [activeTab, setActiveTab] = useState<SettingsTab>('account');

  const [summaryPromptDraft, setSummaryPromptDraft] = useState('');
  const [summaryPromptLoading, setSummaryPromptLoading] = useState(false);
  const [summaryPromptSaving, setSummaryPromptSaving] = useState(false);
  const [summaryPromptError, setSummaryPromptError] = useState<string | null>(null);
  const [summaryPromptSaved, setSummaryPromptSaved] = useState(false);

  const [speakersLoad, setSpeakersLoad] = useState<SpeakersLoadState>({ status: 'idle' });

  const [speakerProfileEditing, setSpeakerProfileEditing] = useState(false);
  const [speakerProfileDraft, setSpeakerProfileDraft] = useState('');
  const [speakerProfileSaving, setSpeakerProfileSaving] = useState(false);
  const [speakerProfileSaveError, setSpeakerProfileSaveError] = useState<string | null>(null);
  const [speakerProfileSavedFlash, setSpeakerProfileSavedFlash] = useState(false);

  const [expandedOtherSpeakerId, setExpandedOtherSpeakerId] = useState<string | null>(null);
  const [otherSpeakerEditingId, setOtherSpeakerEditingId] = useState<string | null>(null);
  const [otherSpeakerDraft, setOtherSpeakerDraft] = useState('');
  const [otherSpeakerSaving, setOtherSpeakerSaving] = useState(false);
  const [otherSpeakerSaveError, setOtherSpeakerSaveError] = useState<string | null>(null);

  const matchedSelf = useMemo((): SpeakerRow | null => {
    if (speakersLoad.status !== 'ready') return null;
    return findBestSpeakerRowForMsAccount(speakersLoad.rows, user?.displayName ?? '');
  }, [speakersLoad, user?.displayName]);

  const otherSpeakers = useMemo((): SpeakerRow[] => {
    if (speakersLoad.status !== 'ready') return [];
    if (!matchedSelf) return speakersLoad.rows;
    return speakersLoad.rows.filter((r) => r.id !== matchedSelf.id);
  }, [speakersLoad, matchedSelf]);

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
          setSummaryPromptDraft(DEFAULT_SUMMARY_PROMPT);
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
    if (!user?.id || !isAuthenticated) return;
    let cancelled = false;
    const load = async () => {
      setSpeakersLoad({ status: 'loading' });
      try {
        const { data, error } = await supabase
          .from('speaker')
          .select('id, name, profile')
          .eq('user_id', user.id)
          .order('name', { ascending: true });
        if (cancelled) return;
        if (error) throw error;
        setSpeakersLoad({ status: 'ready', rows: (data ?? []) as SpeakerRow[] });
      } catch (err: unknown) {
        if (!cancelled) {
          setSpeakersLoad({
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
  }, [user?.id, isAuthenticated]);

  useEffect(() => {
    if (activeTab !== 'account') {
      setSpeakerProfileEditing(false);
      setSpeakerProfileSaveError(null);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'speaker') {
      setExpandedOtherSpeakerId(null);
      setOtherSpeakerEditingId(null);
      setOtherSpeakerSaveError(null);
    }
  }, [activeTab]);

  const handleSaveSpeakerProfile = useCallback(async () => {
    if (!user?.id || !matchedSelf) return;
    setSpeakerProfileSaving(true);
    setSpeakerProfileSaveError(null);
    try {
      const toSave = canonicalOntologyProfileString(speakerProfileDraft);
      const { error } = await supabase
        .from('speaker')
        .update({ profile: toSave })
        .eq('id', matchedSelf.id)
        .eq('user_id', user.id);
      if (error) throw error;
      setSpeakersLoad((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          status: 'ready',
          rows: prev.rows.map((r) => (r.id === matchedSelf.id ? { ...r, profile: toSave } : r)),
        };
      });
      setSpeakerProfileEditing(false);
      setSpeakerProfileSavedFlash(true);
      window.setTimeout(() => setSpeakerProfileSavedFlash(false), 2500);
    } catch (err: unknown) {
      setSpeakerProfileSaveError(err instanceof Error ? err.message : 'Failed to save speaker profile');
    } finally {
      setSpeakerProfileSaving(false);
    }
  }, [user?.id, matchedSelf, speakerProfileDraft]);

  const handleSaveOtherSpeakerProfile = useCallback(async () => {
    if (!user?.id || !otherSpeakerEditingId) return;
    setOtherSpeakerSaving(true);
    setOtherSpeakerSaveError(null);
    try {
      const toSave = canonicalOntologyProfileString(otherSpeakerDraft);
      const id = otherSpeakerEditingId;
      const { error } = await supabase.from('speaker').update({ profile: toSave }).eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      setSpeakersLoad((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          status: 'ready',
          rows: prev.rows.map((r) => (r.id === id ? { ...r, profile: toSave } : r)),
        };
      });
      setOtherSpeakerEditingId(null);
    } catch (err: unknown) {
      setOtherSpeakerSaveError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setOtherSpeakerSaving(false);
    }
  }, [user?.id, otherSpeakerEditingId, otherSpeakerDraft]);

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
        <div className="mx-auto flex min-h-0 w-full max-w-[min(92vw,67.2rem)] flex-1 flex-col gap-4">
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
                Speaker Profiles
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeTab === 'account' ? (
                <section
                  id="settings-panel-account"
                  role="tabpanel"
                  aria-labelledby="settings-tab-account"
                  className="card flex max-h-[min(78vh,36rem)] min-h-[10rem] flex-col overflow-hidden rounded-lg p-0"
                >
                  <div
                    className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-4">
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
                    {speakersLoad.status === 'ready' && matchedSelf ? (
                      speakerProfileEditing ? (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={speakerProfileSaving}
                            onClick={() => {
                              const m = matchedSelf;
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
                            const m = matchedSelf;
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

                  {speakersLoad.status === 'loading' || speakersLoad.status === 'idle' ? (
                    <div className="flex flex-1 items-center gap-2 px-5 py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                      Loading speaker data…
                    </div>
                  ) : null}

                  {speakersLoad.status === 'error' ? (
                    <div className="px-5 py-4">
                      <p className="text-sm" style={{ color: 'var(--error)' }}>
                        {speakersLoad.message}
                      </p>
                    </div>
                  ) : null}

                  {speakersLoad.status === 'ready' && !matchedSelf ? (
                    <div className="px-5 py-4">
                      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        No saved speaker matched your Microsoft name. Names in transcripts are compared after
                        normalizing punctuation and alternate-script parentheses—label yourself in a transcript or add a
                        matching saved speaker.
                      </p>
                    </div>
                  ) : null}

                  {speakersLoad.status === 'ready' && matchedSelf ? (
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
                        ) : matchedSelf.profile ? (
                          <SpeakerOntologyView raw={matchedSelf.profile} embedded />
                        ) : (
                          <div
                            className="flex flex-col items-center justify-center py-12 text-center"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <User className="mb-3 h-10 w-10 opacity-40" aria-hidden />
                            <p className="text-sm">No ontology profile stored yet.</p>
                            <p className="mt-2 max-w-sm text-xs leading-relaxed">
                              Use <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Edit profile</span>{' '}
                              to add JSON.
                            </p>
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
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
                  className="card rounded-lg p-5"
                >
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                    Other speaker profiles
                  </h3>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Saved speakers on your account (excluding the profile matched to your Microsoft name on the Account
                    tab).
                  </p>

                  {speakersLoad.status === 'loading' || speakersLoad.status === 'idle' ? (
                    <div className="mt-6 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                      Loading speaker profiles…
                    </div>
                  ) : null}

                  {speakersLoad.status === 'error' ? (
                    <p className="mt-6 text-sm" style={{ color: 'var(--error)' }}>
                      {speakersLoad.message}
                    </p>
                  ) : null}

                  {speakersLoad.status === 'ready' && otherSpeakers.length === 0 ? (
                    <p className="mt-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {matchedSelf
                        ? 'No other saved speakers for this account.'
                        : 'No saved speakers yet. Speakers are created when you label or save names in transcripts.'}
                    </p>
                  ) : null}

                  {speakersLoad.status === 'ready' && otherSpeakers.length > 0 ? (
                    <div className="mt-6 space-y-2">
                      {otherSpeakers.map((sp) => {
                        const isExpanded = expandedOtherSpeakerId === sp.id;
                        const isEditing = otherSpeakerEditingId === sp.id;
                        return (
                          <div
                            key={sp.id}
                            className="overflow-hidden rounded-xl border"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              aria-controls={`other-speaker-panel-${sp.id}`}
                              id={`other-speaker-trigger-${sp.id}`}
                              onClick={() => {
                                setOtherSpeakerEditingId(null);
                                setOtherSpeakerSaveError(null);
                                setExpandedOtherSpeakerId((prev) => (prev === sp.id ? null : sp.id));
                              }}
                              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:opacity-95"
                              style={{
                                backgroundColor: isExpanded ? 'var(--bg-secondary)' : 'transparent',
                              }}
                            >
                              <div
                                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                                style={{
                                  backgroundColor: 'color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))',
                                  color: 'var(--accent)',
                                }}
                              >
                                {(sp.name || '?').slice(0, 2).toUpperCase()}
                              </div>
                              <span className="min-w-0 flex-1 truncate font-medium" style={{ color: 'var(--text)' }}>
                                {sp.name}
                              </span>
                              <ChevronDown
                                className={`h-4 w-4 shrink-0 transition-transform duration-200 ${
                                  isExpanded ? 'rotate-180' : ''
                                }`}
                                style={{ color: 'var(--text-muted)' }}
                                aria-hidden
                              />
                            </button>

                            {isExpanded ? (
                              <div
                                id={`other-speaker-panel-${sp.id}`}
                                role="region"
                                aria-labelledby={`other-speaker-trigger-${sp.id}`}
                                className="border-t px-4 pb-4 pt-3"
                                style={{ borderColor: 'var(--border)' }}
                              >
                                <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
                                  {isEditing ? (
                                    <>
                                      <button
                                        type="button"
                                        disabled={otherSpeakerSaving}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const p = sp.profile?.trim() || null;
                                          if (p && isOntologyProfile(p)) {
                                            try {
                                              setOtherSpeakerDraft(JSON.stringify(JSON.parse(p), null, 2));
                                            } catch {
                                              setOtherSpeakerDraft(p);
                                            }
                                          } else {
                                            setOtherSpeakerDraft(p ?? '');
                                          }
                                          setOtherSpeakerEditingId(null);
                                          setOtherSpeakerSaveError(null);
                                        }}
                                        className="rounded-lg px-3 py-2 text-sm transition-opacity disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        disabled={otherSpeakerSaving || !user?.id}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleSaveOtherSpeakerProfile();
                                        }}
                                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                                        style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                      >
                                        {otherSpeakerSaving ? (
                                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                        ) : (
                                          <Save className="h-4 w-4" aria-hidden />
                                        )}
                                        Save
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const p = sp.profile?.trim() || null;
                                        if (p && isOntologyProfile(p)) {
                                          try {
                                            setOtherSpeakerDraft(JSON.stringify(JSON.parse(p), null, 2));
                                          } catch {
                                            setOtherSpeakerDraft(p);
                                          }
                                        } else {
                                          setOtherSpeakerDraft(p ?? '');
                                        }
                                        setOtherSpeakerEditingId(sp.id);
                                        setOtherSpeakerSaveError(null);
                                      }}
                                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                                    >
                                      <Pencil className="h-4 w-4" aria-hidden />
                                      Edit profile
                                    </button>
                                  )}
                                </div>

                                {otherSpeakerSaveError && isEditing ? (
                                  <p className="mb-3 text-sm" style={{ color: 'var(--error)' }}>
                                    {otherSpeakerSaveError}
                                  </p>
                                ) : null}

                                <div
                                  className="custom-scrollbar max-h-[min(60vh,28rem)] overflow-y-auto"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {isEditing ? (
                                    <textarea
                                      value={otherSpeakerDraft}
                                      onChange={(e) => setOtherSpeakerDraft(e.target.value)}
                                      className="custom-scrollbar min-h-[14rem] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-[var(--accent)]"
                                      style={{
                                        backgroundColor: 'var(--bg-secondary)',
                                        color: 'var(--text)',
                                        borderColor: 'var(--border)',
                                      }}
                                      spellCheck={false}
                                      aria-label={`Edit profile JSON for ${sp.name}`}
                                      placeholder="{}"
                                    />
                                  ) : sp.profile ? (
                                    <SpeakerOntologyView raw={sp.profile} embedded />
                                  ) : (
                                    <div
                                      className="flex flex-col items-center justify-center py-10 text-center"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      <User className="mb-2 h-9 w-9 opacity-40" aria-hidden />
                                      <p className="text-sm">No profile saved for this speaker.</p>
                                      <p className="mt-2 max-w-sm text-xs leading-relaxed">
                                        Use <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Edit profile</span>{' '}
                                        above to add JSON.
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
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
