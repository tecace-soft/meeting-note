import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AddPlus,
  Check,
  ChevronDown,
  CloseMd,
  Copy,
  EditPencilLine01,
  Loading,
  Save,
  TrashFull,
  User01,
} from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { SpeakerOntologyView } from '../components/SpeakerOntologyView';
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { findBestSpeakerRowForMsAccount } from '../lib/matchSpeakerIdentity';
import { canonicalOntologyProfileString, isOntologyProfile } from '../lib/speakerOntology';
import { DEFAULT_SUMMARY_PROMPT_NAME } from '../constants/defaultSummaryPrompt';

/** Supabase table name (exact identifier in your project). */
const SUMMARY_PROMPT_TABLE = 'summary_prompt';
const MCP_CHATGPT_URL = 'https://meeting-note-mcp.onrender.com/mcp-chatgpt';
const MCP_CLAUDE_URL = 'https://meeting-note-mcp.onrender.com/mcp';

type SettingsTab = 'account' | 'summary' | 'speaker' | 'mcp';
type McpSetupView = 'chatgpt' | 'claude';
type ClientOs = 'windows' | 'macos' | 'linux' | 'unknown';

type SummaryPromptRow = { id: string; name: string; prompt: string };

type SpeakerRow = { id: string; name: string; profile: string | null; email?: string | null; microsoft_id?: string | null };
type McpTokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type SpeakersLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: SpeakerRow[] };

function detectClientOs(): ClientOs {
  if (typeof navigator === 'undefined') return 'unknown';
  const navWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = (navWithUserAgentData.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('linux')) return 'linux';
  return 'unknown';
}

async function callMcpTokenFunction<T>(msAccessToken: string, body: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase URL or anon key is not configured.');
  }

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/mcp-token`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'x-ms-access-token': msAccessToken,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach MCP token Edge Function at ${url}. ${message}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { error: text };
    }
  }

  if (!response.ok) {
    const edgeError = typeof (parsed as { error?: unknown } | null)?.error === 'string'
      ? (parsed as { error: string }).error
      : response.statusText;
    throw new Error(`Edge Function error (${response.status}): ${edgeError}`);
  }

  return parsed as T;
}

const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading, getAccessToken } = useAuth();
  const { appLanguage, setAppLanguage, t } = useLanguage();

  const [activeTab, setActiveTab] = useState<SettingsTab>('account');
  const [mcpSetupView, setMcpSetupView] = useState<McpSetupView>('chatgpt');
  const [mcpTokens, setMcpTokens] = useState<McpTokenRow[]>([]);
  const [mcpTokensLoading, setMcpTokensLoading] = useState(false);
  const [mcpTokenActionLoading, setMcpTokenActionLoading] = useState(false);
  const [mcpTokenError, setMcpTokenError] = useState<string | null>(null);
  const [newMcpToken, setNewMcpToken] = useState<string | null>(null);

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
  const clientOs = useMemo(() => detectClientOs(), []);
  const claudeAuthHeader = newMcpToken ? `Bearer ${newMcpToken}` : 'Generate a key above to fill this value';
  const claudeDesktopConfigMac = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'meeting-note': {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                MCP_CLAUDE_URL,
                '--header',
                'Authorization:${AUTH_HEADER}',
                '--header',
                'x-meeting-note-user-id:${MEETING_NOTE_USER_ID}',
              ],
              env: {
                AUTH_HEADER: claudeAuthHeader,
                MEETING_NOTE_USER_ID: user?.id ?? 'YOUR_MICROSOFT_USER_ID',
              },
            },
          },
        },
        null,
        2
      ),
    [claudeAuthHeader, user?.id]
  );
  const claudeDesktopConfigWindows = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'meeting-note': {
              command: 'npx.cmd',
              args: [
                '-y',
                'mcp-remote',
                MCP_CLAUDE_URL,
                '--header',
                'Authorization:${AUTH_HEADER}',
                '--header',
                'x-meeting-note-user-id:${MEETING_NOTE_USER_ID}',
              ],
              env: {
                AUTH_HEADER: claudeAuthHeader,
                MEETING_NOTE_USER_ID: user?.id ?? 'YOUR_MICROSOFT_USER_ID',
              },
            },
          },
        },
        null,
        2
      ),
    [claudeAuthHeader, user?.id]
  );
  const claudeDesktopConfig = clientOs === 'windows' ? claudeDesktopConfigWindows : claudeDesktopConfigMac;
  const claudeDesktopConfigLabel =
    clientOs === 'windows'
      ? 'Claude Desktop config - Windows'
      : clientOs === 'macos'
        ? 'Claude Desktop config - macOS'
        : clientOs === 'linux'
          ? 'Claude Desktop config - Linux'
          : 'Claude Desktop config';

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
          .select('id, name, profile, email, microsoft_id')
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

  const loadMcpTokens = useCallback(async () => {
    if (!user?.id) return;
    setMcpTokensLoading(true);
    setMcpTokenError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Microsoft access token is unavailable. Please sign in again.');
      const data = await callMcpTokenFunction<{ tokens?: McpTokenRow[]; error?: string }>(token, { action: 'list' });
      if (data?.error) throw new Error(data.error);
      setMcpTokens(data?.tokens ?? []);
    } catch (err) {
      setMcpTokenError(err instanceof Error ? err.message : 'Failed to load MCP keys');
    } finally {
      setMcpTokensLoading(false);
    }
  }, [user?.id, getAccessToken]);

  useEffect(() => {
    if (activeTab === 'mcp' && mcpSetupView === 'claude') {
      void loadMcpTokens();
    }
  }, [activeTab, mcpSetupView, loadMcpTokens]);

  const handleGenerateMcpToken = useCallback(async () => {
    if (!user?.id) return;
    setMcpTokenActionLoading(true);
    setMcpTokenError(null);
    setNewMcpToken(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Microsoft access token is unavailable. Please sign in again.');
      const data = await callMcpTokenFunction<{
        token?: string;
        tokenRecord?: McpTokenRow;
        error?: string;
      }>(token, { action: 'create', name: 'Claude Desktop' });
      if (data?.error) throw new Error(data.error);
      if (!data?.token || !data.tokenRecord) throw new Error('MCP key was not returned.');
      setNewMcpToken(data.token);
      setMcpTokens((prev) => [data.tokenRecord as McpTokenRow, ...prev]);
    } catch (err) {
      setMcpTokenError(err instanceof Error ? err.message : 'Failed to generate MCP key');
    } finally {
      setMcpTokenActionLoading(false);
    }
  }, [user?.id, getAccessToken]);

  const handleRevokeMcpToken = useCallback(async (tokenId: string) => {
    if (!user?.id) return;
    setMcpTokenActionLoading(true);
    setMcpTokenError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Microsoft access token is unavailable. Please sign in again.');
      const data = await callMcpTokenFunction<{ ok?: boolean; error?: string }>(token, { action: 'revoke', tokenId });
      if (data?.error) throw new Error(data.error);
      setMcpTokens((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, revokedAt: new Date().toISOString() } : token))
      );
    } catch (err) {
      setMcpTokenError(err instanceof Error ? err.message : 'Failed to revoke MCP key');
    } finally {
      setMcpTokenActionLoading(false);
    }
  }, [user?.id, getAccessToken]);

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
        <p style={{ color: 'var(--text-secondary)' }}>{t('loadingAccount')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg)' }}>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex min-h-0 w-full max-w-[min(92vw,67.2rem)] flex-1 flex-col gap-4">
          <div className="app-page-header">
            <h1 className="app-page-title">
              {t('accountSettings')}
            </h1>
            <p className="app-page-subtitle">
              {t('accountSettingsSubtitle')}
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
                {t('account')}
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
                {t('summaryPrompts')}
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
                {t('speakerProfiles')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'mcp'}
                id="settings-tab-mcp"
                aria-controls="settings-panel-mcp"
                onClick={() => setActiveTab('mcp')}
                className="rounded-full px-3 py-1.5 text-sm font-medium"
                style={
                  activeTab === 'mcp'
                    ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }
                    : { backgroundColor: 'transparent', color: 'var(--text-secondary)' }
                }
              >
                {t('mcpSetup')}
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
                            {t('cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={speakerProfileSaving || !user?.id}
                            onClick={() => void handleSaveSpeakerProfile()}
                            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                          >
                            {speakerProfileSaving ? (
                              <Loading className="h-4 w-4 animate-spin" aria-hidden />
                            ) : (
                              <Save className="h-4 w-4" aria-hidden />
                            )}
                            {t('save')}
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
                          <EditPencilLine01 className="h-4 w-4" aria-hidden />
                          {t('editProfile')}
                        </button>
                      )
                    ) : null}
                  </div>

                  <div className="shrink-0 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                          {t('appLanguage')}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {t('appLanguageDescription')}
                        </p>
                      </div>
                      <div className="app-language-toggle inline-flex w-fit shrink-0 gap-1 rounded-lg p-1" role="radiogroup" aria-label={t('appLanguage')}>
                        {([
                          ['en', 'English'],
                          ['ko', 'Korean'],
                        ] as const).map(([language, label]) => (
                          <button
                            key={language}
                            type="button"
                            role="radio"
                            aria-checked={appLanguage === language}
                            onClick={() => setAppLanguage(language)}
                            className={`app-language-toggle-option inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                              appLanguage === language ? 'app-language-toggle-option-active' : ''
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {speakersLoad.status === 'loading' || speakersLoad.status === 'idle' ? (
                    <div className="flex flex-1 items-center gap-2 px-5 py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                      {t('loadingSpeakerData')}
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
                            {t('profileSaved')}
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
                                title={appLanguage === 'ko' ? '화자 프로필 JSON 복사' : 'Copy speaker profile JSON'}
                                aria-label={appLanguage === 'ko' ? '화자 프로필 JSON 복사' : 'Copy speaker profile JSON'}
                              >
                                {copiedKey === 'self-speaker-profile' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                {t('copy')}
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
                            <User01 className="mb-3 h-10 w-10 opacity-40" aria-hidden />
                            <p className="text-sm">{appLanguage === 'ko' ? '저장된 온톨로지 프로필이 아직 없습니다.' : 'No ontology profile stored yet.'}</p>
                            <p className="mt-2 max-w-sm text-xs leading-relaxed">
                              {t('useEditProfileHint')}
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
                        {t('summaryPrompts')}
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
                      <AddPlus className="h-4 w-4" aria-hidden />
                      New prompt
                    </button>
                  </div>

                  {summaryPromptListLoading ? (
                    <div className="mt-6 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loading className="h-4 w-4 animate-spin shrink-0" aria-hidden />
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
                    <div className="summary-note-list account-settings-list mt-6">
                      {summaryPrompts.map((row) => {
                        const isExpanded = expandedSummaryPromptId === row.id;
                        return (
                          <div
                            key={row.id}
                            className={`summary-note-row account-settings-row ${isExpanded ? 'summary-note-row-active' : ''}`}
                          >
                            <span className="summary-note-row-rail" aria-hidden />
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
                              className="summary-note-row-content flex w-full items-center gap-3 px-4 py-3 text-left transition-all"
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
                                className="account-settings-expanded border-t px-4 pb-4 pt-3"
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
                                    {t('copy')}
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
                                      <TrashFull className="h-4 w-4" aria-hidden />
                                      {t('delete')}
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
                                      <Loading className="h-4 w-4 animate-spin" aria-hidden />
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
                    {appLanguage === 'ko' ? '기타 화자 프로필' : 'Other speaker profiles'}
                  </h3>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {t('savedSpeakersDescription')}
                  </p>

                  {speakersLoad.status === 'loading' || speakersLoad.status === 'idle' ? (
                    <div className="mt-6 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      <Loading className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                      {t('loadingSpeakerData')}
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
                        ? appLanguage === 'ko' ? '이 계정에는 다른 저장된 화자가 없습니다.' : 'No other saved speakers for this account.'
                        : appLanguage === 'ko' ? '저장된 화자가 아직 없습니다. 전사에서 이름을 지정하거나 저장하면 화자가 생성됩니다.' : 'No saved speakers yet. Speakers are created when you label or save names in transcripts.'}
                    </p>
                  ) : null}

                  {speakersLoad.status === 'ready' && otherSpeakers.length > 0 ? (
                    <div className="summary-note-list account-settings-list mt-6">
                      {otherSpeakers.map((sp) => {
                        const isExpanded = expandedOtherSpeakerId === sp.id;
                        const isEditing = otherSpeakerEditingId === sp.id;
                        return (
                          <div
                            key={sp.id}
                            className={`summary-note-row account-settings-row ${isExpanded ? 'summary-note-row-active' : ''}`}
                          >
                            <span className="summary-note-row-rail" aria-hidden />
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
                              className="summary-note-row-content flex w-full items-center gap-3 px-4 py-3 text-left transition-all"
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
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium" style={{ color: 'var(--text)' }}>
                                  {sp.name}
                                </span>
                                {sp.microsoft_id && sp.email ? (
                                  <span className="block truncate text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                                    {sp.email}
                                  </span>
                                ) : null}
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
                                className="account-settings-expanded border-t px-4 pb-4 pt-3"
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
                                      <EditPencilLine01 className="h-4 w-4" aria-hidden />
                                      {t('editProfile')}
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
                                          title={appLanguage === 'ko' ? `${sp.name} 프로필 JSON 복사` : `Copy profile JSON for ${sp.name}`}
                                          aria-label={appLanguage === 'ko' ? `${sp.name} 프로필 JSON 복사` : `Copy profile JSON for ${sp.name}`}
                                        >
                                          {copiedKey === `other-speaker-${sp.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                          {t('copy')}
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
                                        aria-label={appLanguage === 'ko' ? `${sp.name} 프로필 JSON 편집` : `Edit profile JSON for ${sp.name}`}
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
                                          {t('cancel')}
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
                                            <Loading className="h-4 w-4 animate-spin" aria-hidden />
                                          ) : (
                                            <Save className="h-4 w-4" aria-hidden />
                                          )}
                                          {t('save')}
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
                                      <User01 className="mb-2 h-9 w-9 opacity-40" aria-hidden />
                                      <p className="text-sm">{appLanguage === 'ko' ? '이 화자의 저장된 프로필이 없습니다.' : 'No profile saved for this speaker.'}</p>
                                      <p className="mt-2 max-w-sm text-xs leading-relaxed">
                                        {t('useEditProfileHint')}
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

              {activeTab === 'mcp' ? (
                <section
                  id="settings-panel-mcp"
                  role="tabpanel"
                  aria-labelledby="settings-tab-mcp"
                  className="card rounded-lg p-5"
                >
                  <div>
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                      {t('mcpSetupTitle')}
                    </h3>
                    <p className="mt-1 max-w-3xl text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                      {t('mcpSetupDescription')}
                    </p>
                  </div>

                  <div className="results-tabs mt-5 flex min-w-0 gap-5 border-b" role="tablist" aria-label="MCP setup options" style={{ borderColor: 'var(--border)' }}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={mcpSetupView === 'chatgpt'}
                      className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors"
                      onClick={() => setMcpSetupView('chatgpt')}
                    >
                      ChatGPT
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={mcpSetupView === 'claude'}
                      className="results-tab px-1 pb-2.5 pt-1 text-sm font-medium transition-colors"
                      onClick={() => setMcpSetupView('claude')}
                    >
                      Claude
                    </button>
                  </div>

                  <div className="summary-note-list account-settings-list mcp-setup-list mt-0">
                    {mcpSetupView === 'claude' ? (
                    <div className="summary-note-row account-settings-row mcp-setup-row">
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                              {t('personalMcpKey')}
                            </h4>
                            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                              {t('personalMcpKeyDescription')}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleGenerateMcpToken()}
                            disabled={!user?.id || mcpTokenActionLoading}
                            className="mcp-copy-btn disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {mcpTokenActionLoading ? <Loading className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                            {t('generateKey')}
                          </button>
                        </div>

                        {mcpTokenError ? (
                          <p className="mt-3 text-sm" style={{ color: 'var(--error)' }}>
                            {mcpTokenError}
                          </p>
                        ) : null}

                        {newMcpToken ? (
                          <div className="mt-3 overflow-hidden rounded-md" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                            <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                                {t('newMcpKeyCopy')}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCopyText(newMcpToken, 'new-mcp-token')}
                                className="mcp-copy-btn"
                              >
                                {copiedKey === 'new-mcp-token' ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                                {copiedKey === 'new-mcp-token' ? t('copied') : t('copy')}
                              </button>
                            </div>
                            <code className="block overflow-x-auto px-3 py-2 text-xs" style={{ color: 'var(--text)' }}>
                              {newMcpToken}
                            </code>
                          </div>
                        ) : null}

                        <div className="mt-4">
                          <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                            {t('existingKeys')}
                          </h5>
                          {mcpTokensLoading ? (
                            <div className="mt-3 flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                              <Loading className="h-4 w-4 animate-spin" aria-hidden />
                              {t('loadingKeys')}
                            </div>
                          ) : mcpTokens.length === 0 ? (
                            <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                              {t('noMcpKeys')}
                            </p>
                          ) : (
                            <div className="mt-3 overflow-hidden rounded-md" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                              {mcpTokens.map((token) => {
                                const revoked = Boolean(token.revokedAt);
                                return (
                                  <div
                                    key={token.id}
                                    className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-3 last:border-b-0"
                                    style={{ borderColor: 'var(--border)' }}
                                  >
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium" style={{ color: revoked ? 'var(--text-muted)' : 'var(--text)' }}>
                                        {token.name}
                                      </p>
                                      <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {token.tokenPrefix} · Created {new Date(token.createdAt).toLocaleDateString()}
                                        {token.lastUsedAt ? ` · Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : ''}
                                        {revoked ? ' · Revoked' : ''}
                                      </p>
                                    </div>
                                    {!revoked ? (
                                      <button
                                        type="button"
                                        onClick={() => void handleRevokeMcpToken(token.id)}
                                        disabled={mcpTokenActionLoading}
                                        className="rounded-md px-3 py-1.5 text-xs font-semibold transition-opacity disabled:opacity-50"
                                        style={{
                                          backgroundColor: 'color-mix(in srgb, var(--error) 10%, transparent)',
                                          color: 'var(--error)',
                                        }}
                                      >
                                        {t('revoke')}
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    ) : null}

                    {mcpSetupView === 'chatgpt' ? (
                      <div className="summary-note-row account-settings-row mcp-setup-row">
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content px-4 py-4">
                        <div>
                          <div>
                            <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                              {t('chatgptSetup')}
                            </h4>
                            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                              {t('chatgptSetupDescription')}
                            </p>
                          </div>
                        </div>

                        <div className="mt-3 overflow-hidden rounded-md" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                          <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                              {t('chatgptMcpUrl')}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyText(MCP_CHATGPT_URL, 'mcp-chatgpt-url')}
                              className="mcp-copy-btn"
                            >
                              {copiedKey === 'mcp-chatgpt-url' ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                              {copiedKey === 'mcp-chatgpt-url' ? t('copied') : t('copy')}
                            </button>
                          </div>
                          <code className="block overflow-x-auto px-3 py-2 text-xs" style={{ color: 'var(--text)' }}>
                            {MCP_CHATGPT_URL}
                          </code>
                        </div>

                        <ol className="mt-4 space-y-2 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {(appLanguage === 'ko'
                            ? [
                                'ChatGPT 설정을 엽니다.',
                                '커넥터로 이동합니다. 필요한 경우 고급 커넥터 설정에서 개발자 모드를 켭니다.',
                                '원격 MCP 서버를 추가하고 위의 ChatGPT MCP URL을 붙여넣습니다.',
                                'Microsoft 로그인 및 동의 화면을 완료합니다.',
                                '채팅을 시작하고 Meeting Note 데이터를 사용하고 싶을 때 커넥터/도구 메뉴에서 Meeting Note를 선택합니다.',
                              ]
                            : [
                                'Open ChatGPT settings.',
                                'Go to Connectors. If needed, enable Developer mode under the advanced connector settings.',
                                'Add a remote MCP server and paste the ChatGPT MCP URL above.',
                                'Complete the Microsoft sign-in and consent screen.',
                                'Start a chat and choose Meeting Note from the connector/tools menu when you want ChatGPT to use your meeting data.',
                              ]).map((step, index) => (
                            <li key={step}><span className="font-medium" style={{ color: 'var(--text)' }}>{index + 1}.</span> {step}</li>
                          ))}
                        </ol>

                        <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          {appLanguage === 'ko'
                            ? '서버 업데이트 후 ChatGPT에서 계정 연결 오류가 표시되면 커넥터 연결을 해제한 뒤 다시 연결하여 OAuth 권한을 새로고침하세요.'
                            : 'If ChatGPT reports an account connection error after a server update, disconnect the connector and reconnect it so ChatGPT refreshes the OAuth permission grant.'}
                        </p>
                      </div>
                    </div>
                    ) : null}

                    {mcpSetupView === 'claude' ? (
                      <>
                    <div className="summary-note-row account-settings-row mcp-setup-row">
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content px-4 py-4">
                        <div>
                          <div>
                            <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                              {t('claudeDesktopSetup')}
                            </h4>
                            <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                              {appLanguage === 'ko' ? (
                                <>Claude Desktop은 <span className="font-medium">mcp-remote</span>라는 로컬 브리지를 사용합니다. 위에서 생성한 개인 MCP 키를 사용합니다.</>
                              ) : (
                                <>Claude Desktop uses a local bridge called <span className="font-medium">mcp-remote</span>. You will use the personal MCP key generated above.</>
                              )}
                            </p>
                          </div>
                        </div>

                        <ol className="mt-4 space-y-2 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {(appLanguage === 'ko'
                            ? [
                                'Claude Desktop 설정을 열고 개발자 MCP 설정 파일을 찾습니다.',
                                '아래 mcpServers 블록을 기존 JSON에 추가합니다. 기존 설정이 있으면 유지하고 mcpServers를 같은 레벨의 속성으로 추가합니다.',
                                '위에서 개인 MCP 키를 생성합니다. 아래 설정은 마지막으로 생성된 키를 env.AUTH_HEADER에 넣습니다.',
                                '키를 생성한 뒤 설정을 복사하여 Claude가 올바른 인증 헤더와 Meeting Note 사용자 ID를 받도록 합니다.',
                                'Claude Desktop을 다시 시작하고 Meeting Note MCP 도구가 보이는지 확인합니다.',
                              ]
                            : [
                                'Open Claude Desktop settings and locate the developer MCP configuration file.',
                                'Add the mcpServers block below to the existing JSON. If the file already has preferences, keep them and add mcpServers as a sibling property.',
                                'Generate a personal MCP key above. The config below will place the last generated key under env.AUTH_HEADER.',
                                'Copy the config after generating the key so Claude receives the correct auth header and your Meeting Note user ID.',
                                'Restart Claude Desktop and look for the Meeting Note MCP tools.',
                              ]).map((step, index) => (
                            <li key={step}><span className="font-medium" style={{ color: 'var(--text)' }}>{index + 1}.</span> {step}</li>
                          ))}
                        </ol>

                        <div className="mt-4 overflow-hidden rounded-md" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                          <div className="flex items-center justify-between gap-3 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                              {claudeDesktopConfigLabel}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyText(claudeDesktopConfig, 'mcp-claude-config')}
                              className="mcp-copy-btn"
                            >
                              {copiedKey === 'mcp-claude-config' ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                              {copiedKey === 'mcp-claude-config' ? t('copied') : t('copy')}
                            </button>
                          </div>
                          <pre className="custom-scrollbar max-h-80 overflow-auto p-3 text-xs leading-relaxed" style={{ color: 'var(--text)' }}>
                            <code>{claudeDesktopConfig}</code>
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div className="summary-note-row account-settings-row mcp-setup-row">
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content px-4 py-4">
                        <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                          {t('keySafety')}
                        </h4>
                        <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {appLanguage === 'ko'
                            ? '개인 MCP 키는 Meeting Note 계정에만 연결됩니다. 키는 Claude Desktop에만 저장하고, 더 이상 필요하지 않거나 노출되었을 수 있으면 여기에서 해지하세요.'
                            : 'Personal MCP keys are scoped to your Meeting Note account. Store the key in Claude Desktop only, and revoke it here if it is no longer needed or may have been exposed.'}
                        </p>
                        <div className="mt-3 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                          {appLanguage === 'ko'
                            ? '전체 키는 한 번만 표시됩니다. 기존 키는 식별을 위해 축약된 라벨만 표시됩니다.'
                            : 'The full key is only shown once. Existing keys show a shortened label for identification.'}
                        </div>
                      </div>
                    </div>
                    </>
                    ) : null}

                    <div className="summary-note-row account-settings-row mcp-setup-row">
                      <span className="summary-note-row-rail" aria-hidden />
                      <div className="summary-note-row-content px-4 py-4">
                        <h4 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                          {t('quickTestPrompts')}
                        </h4>
                        <ul className="mt-3 space-y-2 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                          {(appLanguage === 'ko'
                            ? [
                                '최근 회의록을 나열해 주세요.',
                                '어제 회의록을 찾아 실행 항목을 요약해 주세요.',
                                '프로젝트 리스크에 대해 논의한 전사를 검색해 주세요.',
                                '저장된 화자의 프로필 컨텍스트를 보여 주세요.',
                              ]
                            : [
                                'List my recent meeting notes.',
                                'Find notes from yesterday and summarize the action items.',
                                'Search my transcripts for a discussion about project risks.',
                                'Show the profile context for a saved speaker.',
                              ]).map((prompt) => <li key={prompt}>{prompt}</li>)}
                        </ul>
                        <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          {t('mcpReadOnlyNote')}
                        </p>
                      </div>
                    </div>
                  </div>
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
                <CloseMd className="h-5 w-5" aria-hidden />
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
                  {t('copy')}
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
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={createSaving || !user?.id}
                onClick={() => void handleCreateSummaryPrompt()}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {createSaving ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
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
                {t('deletePrompt')}
              </h2>
              <button
                type="button"
                disabled={deletePromptSaving}
                onClick={() => setPendingDeletePrompt(null)}
                className="rounded-md p-2 transition-opacity disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <CloseMd className="h-5 w-5" aria-hidden />
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
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={deletePromptSaving || !user?.id}
                onClick={() => void handleConfirmDeleteSummaryPrompt()}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'var(--error)', color: 'var(--error)', backgroundColor: 'transparent' }}
              >
                {deletePromptSaving ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : <TrashFull className="h-4 w-4" aria-hidden />}
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AccountSettings;
