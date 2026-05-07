import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, Copy, Loader2, Pencil, Plus, Save, Trash2, User, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { SpeakerOntologyView } from '../components/SpeakerOntologyView';
import { supabase } from '../config/supabaseConfig';
import { findBestSpeakerRowForMsAccount } from '../lib/matchSpeakerIdentity';
import { canonicalOntologyProfileString, isOntologyProfile } from '../lib/speakerOntology';
import { DEFAULT_SUMMARY_PROMPT_NAME } from '../constants/defaultSummaryPrompt';

/** Supabase table name (exact identifier in your project). */
const SUMMARY_PROMPT_TABLE = 'summary_prompt';

type SettingsTab = 'account' | 'summary' | 'speaker';

type SummaryPromptRow = { id: string; name: string; prompt: string };

type SpeakerRow = { id: string; name: string; profile: string | null };

type SpeakersLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: SpeakerRow[] };

const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading } = useAuth();

  const [activeTab, setActiveTab] = useState<SettingsTab>('account');

  const [summaryPrompts, setSummaryPrompts] = useState<SummaryPromptRow[]>([]);
  const [summaryPromptListLoading, setSummaryPromptListLoading] = useState(false);
  const [summaryPromptListError, setSummaryPromptListError] = useState<string | null>(null);
  const [expandedSummaryPromptId, setExpandedSummaryPromptId] = useState<string | null>(null);
  const [expandedPromptDraft, setExpandedPromptDraft] = useState('');
  const [savePromptSaving, setSavePromptSaving] = useState(false);
  const [savePromptError, setSavePromptError] = useState<string | null>(null);
  const [savePromptOkFlash, setSavePromptOkFlash] = useState(false);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createPrompt, setCreatePrompt] = useState('');
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [pendingDeletePrompt, setPendingDeletePrompt] = useState<{ id: string; name: string } | null>(null);
  const [deletePromptSaving, setDeletePromptSaving] = useState(false);
  const [deletePromptError, setDeletePromptError] = useState<string | null>(null);

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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
      setSummaryPromptListLoading(true);
      setSummaryPromptListError(null);
      try {
        const { data, error } = await supabase
          .from(SUMMARY_PROMPT_TABLE)
          .select('id, name, prompt')
          .eq('user_id', user.id)
          .order('name', { ascending: true });

        if (cancelled) return;
        if (error) throw error;
        setSummaryPrompts((data ?? []) as SummaryPromptRow[]);
      } catch (err: unknown) {
        if (!cancelled) {
          setSummaryPromptListError(err instanceof Error ? err.message : 'Failed to load summary prompts');
        }
      } finally {
        if (!cancelled) setSummaryPromptListLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isAuthenticated]);

  useEffect(() => {
    if (activeTab !== 'summary') {
      setCreateModalOpen(false);
      setExpandedSummaryPromptId(null);
      setCreateError(null);
    }
  }, [activeTab]);

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

  const handleSaveExpandedSummaryPrompt = useCallback(async () => {
    if (!user?.id || !expandedSummaryPromptId) return;
    setSavePromptSaving(true);
    setSavePromptError(null);
    setSavePromptOkFlash(false);
    try {
      const { error } = await supabase
        .from(SUMMARY_PROMPT_TABLE)
        .update({ prompt: expandedPromptDraft })
        .eq('id', expandedSummaryPromptId)
        .eq('user_id', user.id);
      if (error) throw error;
      setSummaryPrompts((prev) =>
        prev.map((r) => (r.id === expandedSummaryPromptId ? { ...r, prompt: expandedPromptDraft } : r))
      );
      setSavePromptOkFlash(true);
      window.setTimeout(() => setSavePromptOkFlash(false), 2500);
    } catch (err: unknown) {
      setSavePromptError(err instanceof Error ? err.message : 'Failed to save prompt');
    } finally {
      setSavePromptSaving(false);
    }
  }, [user?.id, expandedSummaryPromptId, expandedPromptDraft]);

  const openCreatePromptModal = useCallback(() => {
    setCreateError(null);
    setCreateName('');
    setCreatePrompt('');
    setCreateModalOpen(true);
  }, []);

  const handleCreateSummaryPrompt = useCallback(async () => {
    if (!user?.id) return;
    const nameTrim = createName.trim();
    const promptTrim = createPrompt.trim();
    if (!nameTrim || !promptTrim) {
      setCreateError('Name and prompt are required.');
      return;
    }
    setCreateSaving(true);
    setCreateError(null);
    try {
      const { data, error } = await supabase
        .from(SUMMARY_PROMPT_TABLE)
        .insert({ user_id: user.id, name: nameTrim, prompt: promptTrim })
        .select('id, name, prompt')
        .maybeSingle();
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505') {
          setCreateError('A prompt with this name already exists.');
          return;
        }
        throw error;
      }
      if (data) {
        setSummaryPrompts((prev) => [...prev, data as SummaryPromptRow].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setCreateModalOpen(false);
      setCreateName('');
      setCreatePrompt('');
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create prompt');
    } finally {
      setCreateSaving(false);
    }
  }, [user?.id, createName, createPrompt]);

  const openDeletePromptModal = useCallback((row: SummaryPromptRow) => {
    if (row.name === DEFAULT_SUMMARY_PROMPT_NAME) return;
    setDeletePromptError(null);
    setPendingDeletePrompt({ id: row.id, name: row.name });
  }, []);

  const handleConfirmDeleteSummaryPrompt = useCallback(async () => {
    if (!user?.id || !pendingDeletePrompt) return;
    if (pendingDeletePrompt.name === DEFAULT_SUMMARY_PROMPT_NAME) return;
    const { id } = pendingDeletePrompt;
    setDeletePromptSaving(true);
    setDeletePromptError(null);
    try {
      const { error } = await supabase.from(SUMMARY_PROMPT_TABLE).delete().eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      setSummaryPrompts((prev) => prev.filter((r) => r.id !== id));
      setExpandedSummaryPromptId((prev) => (prev === id ? null : prev));
      setPendingDeletePrompt(null);
      setSavePromptError(null);
      setSavePromptOkFlash(false);
    } catch (err: unknown) {
      setDeletePromptError(err instanceof Error ? err.message : 'Failed to delete prompt');
    } finally {
      setDeletePromptSaving(false);
    }
  }, [user?.id, pendingDeletePrompt]);

  const handleCopyText = useCallback(async (text: string, key: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  }, []);

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
                Summary prompts
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
                          <>
                            <div className="mb-2 flex justify-end">
                              <button
                                type="button"
                                onClick={() => void handleCopyText(speakerProfileDraft, 'self-speaker-profile')}
                                className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium"
                                style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                title="Copy speaker profile JSON"
                                aria-label="Copy speaker profile JSON"
                              >
                                {copiedKey === 'self-speaker-profile' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                Copy
                              </button>
                            </div>
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
                          </>
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
                        Summary prompts
                      </h3>
                      <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Named templates stored on your account. The Meeting Note page can choose which template to send with
                        summarization.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={summaryPromptListLoading || !user?.id}
                      onClick={openCreatePromptModal}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <Plus className="h-4 w-4" aria-hidden />
                      New prompt
                    </button>
                  </div>

                  {summaryPromptListLoading ? (
                    <div className="mt-6 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
                      Loading prompts…
                    </div>
                  ) : summaryPromptListError ? (
                    <p className="mt-6 text-sm" style={{ color: 'var(--error)' }}>
                      {summaryPromptListError}
                    </p>
                  ) : summaryPrompts.length === 0 ? (
                    <p className="mt-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      No prompts yet. Create one with <span className="font-medium">New prompt</span>, or open Meeting Note—
                      a default prompt is created automatically on first visit.
                    </p>
                  ) : (
                    <div className="mt-6 space-y-2">
                      {summaryPrompts.map((row) => {
                        const isExpanded = expandedSummaryPromptId === row.id;
                        return (
                          <div
                            key={row.id}
                            className="overflow-hidden rounded-xl border"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              aria-controls={`summary-prompt-panel-${row.id}`}
                              id={`summary-prompt-trigger-${row.id}`}
                              onClick={() => {
                                setSavePromptError(null);
                                setSavePromptOkFlash(false);
                                setExpandedSummaryPromptId((prev) => {
                                  if (prev === row.id) return null;
                                  setExpandedPromptDraft(row.prompt);
                                  return row.id;
                                });
                              }}
                              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:opacity-95"
                              style={{
                                backgroundColor: isExpanded ? 'var(--bg-secondary)' : 'transparent',
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate font-medium" style={{ color: 'var(--text)' }}>
                                {row.name}
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
                                id={`summary-prompt-panel-${row.id}`}
                                role="region"
                                aria-labelledby={`summary-prompt-trigger-${row.id}`}
                                className="border-t px-4 pb-4 pt-3"
                                style={{ borderColor: 'var(--border)' }}
                              >
                                <div className="mb-2 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyText(expandedPromptDraft, `summary-prompt-${row.id}`)}
                                    className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium"
                                    style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                    title={`Copy prompt for ${row.name}`}
                                    aria-label={`Copy prompt for ${row.name}`}
                                  >
                                    {copiedKey === `summary-prompt-${row.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                    Copy
                                  </button>
                                </div>
                                <textarea
                                  value={expandedPromptDraft}
                                  onChange={(e) => setExpandedPromptDraft(e.target.value)}
                                  className="custom-scrollbar min-h-[18rem] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-[var(--accent)]"
                                  style={{
                                    backgroundColor: 'var(--bg-secondary)',
                                    color: 'var(--text)',
                                    borderColor: 'var(--border)',
                                  }}
                                  spellCheck={false}
                                  aria-label={`Prompt text for ${row.name}`}
                                />
                                {savePromptError ? (
                                  <p className="mt-3 text-sm" style={{ color: 'var(--error)' }}>
                                    {savePromptError}
                                  </p>
                                ) : null}
                                {savePromptOkFlash ? (
                                  <p className="mt-3 text-sm" style={{ color: 'var(--success)' }}>
                                    Saved.
                                  </p>
                                ) : null}
                                <div
                                  className={`mt-3 flex flex-wrap items-center gap-2 ${
                                    row.name === DEFAULT_SUMMARY_PROMPT_NAME ? 'justify-end' : 'justify-between'
                                  }`}
                                >
                                  {row.name !== DEFAULT_SUMMARY_PROMPT_NAME ? (
                                    <button
                                      type="button"
                                      disabled={savePromptSaving || deletePromptSaving || !user?.id}
                                      onClick={() => openDeletePromptModal(row)}
                                      className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                                      style={{
                                        borderColor: 'var(--error)',
                                        color: 'var(--error)',
                                        backgroundColor: 'transparent',
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" aria-hidden />
                                      Delete
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={savePromptSaving || deletePromptSaving || !user?.id}
                                    onClick={() => void handleSaveExpandedSummaryPrompt()}
                                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                                    style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                                  >
                                    {savePromptSaving ? (
                                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                    ) : (
                                      <Save className="h-4 w-4" aria-hidden />
                                    )}
                                    Save
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
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
                                {!isEditing ? (
                                  <div className="mb-3 flex justify-end">
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
                                  </div>
                                ) : null}

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
                                    <>
                                      <div className="mb-2 flex justify-end">
                                        <button
                                          type="button"
                                          onClick={() => void handleCopyText(otherSpeakerDraft, `other-speaker-${sp.id}`)}
                                          className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium"
                                          style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                                          title={`Copy profile JSON for ${sp.name}`}
                                          aria-label={`Copy profile JSON for ${sp.name}`}
                                        >
                                          {copiedKey === `other-speaker-${sp.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                          Copy
                                        </button>
                                      </div>
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
                                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
                                      </div>
                                    </>
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

      {createModalOpen ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!createSaving) setCreateModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-summary-prompt-title"
            className="flex max-h-[min(90vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-xl"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <h2 id="create-summary-prompt-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                New summary prompt
              </h2>
              <button
                type="button"
                disabled={createSaving}
                onClick={() => setCreateModalOpen(false)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
              <label className="block text-sm font-medium" style={{ color: 'var(--text)' }}>
                Name
              </label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text)',
                  borderColor: 'var(--border)',
                }}
                placeholder="e.g. Weekly standup"
                disabled={createSaving}
                autoComplete="off"
              />
              <label className="mt-4 block text-sm font-medium" style={{ color: 'var(--text)' }}>
                Prompt
              </label>
              <textarea
                value={createPrompt}
                onChange={(e) => setCreatePrompt(e.target.value)}
                className="custom-scrollbar mt-1.5 min-h-[12rem] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text)',
                  borderColor: 'var(--border)',
                }}
                spellCheck={false}
                placeholder="Instructions for the summarization model…"
                disabled={createSaving}
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleCopyText(createPrompt, 'create-summary-prompt')}
                  className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium"
                  style={{ backgroundColor: 'var(--bg)', color: 'var(--text-secondary)' }}
                  title="Copy prompt draft"
                  aria-label="Copy prompt draft"
                  disabled={!createPrompt.trim()}
                >
                  {copiedKey === 'create-summary-prompt' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy
                </button>
              </div>
              {createError ? (
                <p className="mt-3 text-sm" style={{ color: 'var(--error)' }}>
                  {createError}
                </p>
              ) : null}
            </div>
            <div
              className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 sm:px-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                disabled={createSaving}
                onClick={() => setCreateModalOpen(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={createSaving || !user?.id}
                onClick={() => void handleCreateSummaryPrompt()}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {createSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeletePrompt ? (
        <div
          className="fixed inset-0 z-[71] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          role="presentation"
          onClick={() => {
            if (!deletePromptSaving) setPendingDeletePrompt(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-summary-prompt-title"
            className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border shadow-xl"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <h2 id="delete-summary-prompt-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                Delete prompt
              </h2>
              <button
                type="button"
                disabled={deletePromptSaving}
                onClick={() => setPendingDeletePrompt(null)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <div className="px-4 py-4 sm:px-5">
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                Delete <span className="font-medium" style={{ color: 'var(--text)' }}>{pendingDeletePrompt.name}</span>?
                This cannot be undone.
              </p>
              {deletePromptError ? (
                <p className="mt-3 text-sm" style={{ color: 'var(--error)' }}>
                  {deletePromptError}
                </p>
              ) : null}
            </div>
            <div
              className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-4 py-3 sm:px-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                disabled={deletePromptSaving}
                onClick={() => setPendingDeletePrompt(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletePromptSaving || !user?.id}
                onClick={() => void handleConfirmDeleteSummaryPrompt()}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'var(--error)', color: 'var(--error)', backgroundColor: 'transparent' }}
              >
                {deletePromptSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AccountSettings;
