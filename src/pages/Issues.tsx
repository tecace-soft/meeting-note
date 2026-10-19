// F2: feedback / issue tracker board (spec docs/feedback-issues-porting-prompt.md).
// Register, list and triage on one screen. The triage draft lives here, once, and is
// shared by the fixed column (>= 1536px) and the slide-over (< 1536px) (TRIAGE-5).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings } from 'react-coolicons';
import { useLocation } from 'react-router-dom';
import { CreateForm, CreateSuccess } from '../components/issues/CreateForm';
import { ListPanel } from '../components/issues/ListPanel';
import { ConfirmDialog } from '../components/issues/parts';
import { RecipientsDialog } from '../components/issues/RecipientsDialog';
import { SlideOver } from '../components/issues/SlideOver';
import { TriageEmpty, TriagePanel, type TriageActions } from '../components/issues/TriagePanel';
import { useMediaQuery, useTriageDraft } from '../components/issues/hooks';
import '../components/issues/issues.css';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { isOpenStatus } from '../lib/issues/constants';
import type { ListFilter } from '../lib/issues/listFilter';
import { mailAfterSave, savedText } from '../lib/issues/mailDecision';
import { canIssue } from '../lib/issues/permissions';
import {
  fetchDirectory, fetchRecipients, isMissingSchemaError, listIssues, saveResolution, saveTriage, signAttachmentUrls,
  softDeleteIssue, type RecipientsResult,
} from '../lib/issues/service';
import { RESOLUTION_PATH, ResolutionServerError, generateResolution, notifyAfterTriage } from '../lib/issues/serverApi';
import { ISSUE_STRINGS, operationError } from '../lib/issues/strings';
import type { DirectoryUser, Issue } from '../lib/issues/types';

type Pane = 'new' | 'list';

export default function Issues() {
  const { user, isAuthenticated, getAccessToken, verifiedEmail } = useAuth();
  const { appLanguage: lang } = useLanguage();
  const s = ISSUE_STRINGS[lang];
  const location = useLocation();
  // Display / assignee matching only: the JWT email, falling back to the MSAL username.
  const me = (verifiedEmail ?? user?.email ?? '').toLowerCase() || null;
  // Ownership is the Microsoft object id (DB author_id = JWT sub), never the email: a Graph
  // `mail` can be set by any tenant admin (security review 2026-10-15).
  const myId = user?.id?.trim().toLowerCase() || null;
  const canTriage = canIssue(user?.id, 'issues.triage');
  const canNotify = canIssue(user?.id, 'issues.notify');
  const wide = useMediaQuery('(min-width: 1536px)');
  const mid = useMediaQuery('(min-width: 1280px)');

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [recipients, setRecipients] = useState<RecipientsResult | null>(null);
  const [filter, setFilter] = useState<ListFilter>({ view: 'open', query: '', assignee: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [newIssueId, setNewIssueId] = useState<string | null>(null);
  const [created, setCreated] = useState<{ issueKey: string; notified: string[] | null } | null>(null);
  const [saveResult, setSaveResult] = useState<{ id: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('new');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const savingRef = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listIssues();
      setIssues(rows);
      setListError(false);
      const signed = await signAttachmentUrls(rows.flatMap((r) => r.attachments.map((a) => a.path)));
      setUrls((prev) => ({ ...prev, ...signed }));
    } catch (error) {
      console.error('Issue list load failed:', error);
      setListError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Same pattern as the other screens (AppSidebar, SummaryHistory): read only once auth has
  // settled with a user, and again if the user changes. Reading on mount raced the token
  // provider and went out as anon (prod bug 2026-10-15: empty list, 401 on the directory).
  const authReady = isAuthenticated && !!user?.id;
  useEffect(() => {
    if (!authReady) return;
    void reload();
    void fetchDirectory().then(setDirectory);
    void fetchRecipients().then(setRecipients);
  }, [authReady, user?.id, reload]);

  // Deep link from the notification mail: /issues?issue=<issueKey> selects and opens it.
  const wantKey = useRef<string | null>(new URLSearchParams(location.search).get('issue'));
  useEffect(() => {
    if (!wantKey.current) return;
    const match = issues.find((i) => i.issueKey === wantKey.current);
    if (!match) return;
    wantKey.current = null;
    setSelectedId(match.id);
    setPanelOpen(true);
    setPane('list');
    if (!isOpenStatus(match.status)) setFilter((f) => ({ ...f, view: 'all' }));
  }, [issues]);

  const selected = issues.find((i) => i.id === selectedId) ?? null;
  const [draft, setDraft, resetDraft] = useTriageDraft(selected);
  const isAuthor = !!selected && !!myId && selected.authorId === myId;
  // Same rule as soft_delete_feedback_issue(): the author, or an admin for rows without author_id.
  const canDelete = isAuthor || (!!selected && selected.authorId === null && canTriage);

  const select = useCallback((id: string) => {
    if (id !== selectedId) {
      setSaveResult(null);
      setAiError(null);
    }
    setSelectedId(id);
    setPanelOpen(true);
  }, [selectedId]);

  const replaceIssue = (updated: Issue) => setIssues((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));

  const save = async () => {
    if (!selected || !draft || savingRef.current) return; // TRIAGE-6: ignore double clicks
    savingRef.current = true;
    setSaving(true);
    try {
      const updated = await saveTriage(selected.id, draft, me ?? '');
      const decision = mailAfterSave(selected, updated, { email: me ?? '', id: myId });
      if (decision.assigneeMailed) notifyAfterTriage('assigned', updated.issueKey, getAccessToken);
      if (decision.authorMailed) notifyAfterTriage('resolved', updated.issueKey, getAccessToken);
      setSaveResult({ id: updated.id, text: savedText(new Date(), decision, updated.assigneeName, lang) });
      setOpError(null);
      resetDraft(updated);
      replaceIssue(updated);
      void reload();
    } catch (error) {
      setOpError(operationError(s, s.opTriage, error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const generate = async () => {
    if (!selected || aiRunning) return;
    const target = selected;
    setAiRunning(true);
    setAiError(null);
    let result: Awaited<ReturnType<typeof generateResolution>>;
    try {
      result = await generateResolution(target, getAccessToken);
    } catch (error) {
      setAiError(error instanceof ResolutionServerError && error.kind === 'unreachable'
        ? s.aiUnreachable(RESOLUTION_PATH, error.status)
        : s.aiFailed(error instanceof Error ? error.message : String(error)));
      setAiRunning(false);
      return;
    }
    try {
      const updated = await saveResolution(target.id, result.resolution, result.model);
      replaceIssue(updated);
      setOpError(null);
      void reload();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code ?? '';
      setAiError(s.aiSaveFailed(`${raw}${isMissingSchemaError(code, raw) ? s.migrationHint : ''}`));
    } finally {
      setAiRunning(false);
    }
  };

  const confirmDelete = async () => {
    setConfirmOpen(false);
    if (!selected || !canDelete) return;
    try {
      await softDeleteIssue(selected);
      setSelectedId(null);
      setPanelOpen(false);
      setSaveResult(null);
      setOpError(null);
      await reload();
    } catch (error) {
      setOpError(operationError(s, s.opDelete, error));
    }
  };

  const onCreated = (issue: Issue, notified: string[] | null) => {
    setCreated({ issueKey: issue.issueKey, notified });
    setNewIssueId(issue.id);
    setIssues((prev) => [issue, ...prev.filter((i) => i.id !== issue.id)]);
    setOpError(null);
    void reload();
  };

  const actions: TriageActions = {
    saving,
    saveResult: saveResult && saveResult.id === selectedId ? saveResult.text : null,
    aiRunning,
    aiError,
    onSave: () => void save(),
    onDelete: () => setConfirmOpen(true),
    onGenerate: () => void generate(),
  };

  const panel = selected ? (
    <TriagePanel
      key={selected.id}
      s={s}
      lang={lang}
      issue={selected}
      draft={draft}
      setDraft={setDraft}
      canTriage={canTriage}
      canDelete={canDelete}
      directory={directory}
      urls={urls}
      actions={actions}
      headingId="iss-panel-title"
    />
  ) : null;

  const openCount = issues.filter((i) => isOpenStatus(i.status)).length;
  const noRecipients = recipients?.status === 'ok' && recipients.recipients.length === 0;
  const notifyLabel = noRecipients ? s.notifyNone : s.notifyButton;
  const showNew = mid || pane === 'new';
  const showList = mid || pane === 'list';
  const gridClass = wide
    ? 'grid grid-cols-[360px_minmax(0,1fr)_440px] items-start gap-4'
    : mid
      ? 'grid grid-cols-[360px_minmax(0,1fr)] items-start gap-4'
      : 'flex flex-col gap-4';

  return (
    <div className="iss-root h-full overflow-y-auto" style={{ color: 'var(--text)' }}>
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="app-page-header mb-0 min-w-0 flex-1" style={{ flexShrink: 1 }}>
            <h1 className="app-page-title">{s.title}</h1>
            <p className="app-page-subtitle">{s.desc}</p>
          </div>
          <button
            type="button"
            className={`iss-btn flex min-h-[36px] items-center gap-1 px-2 py-1 text-xs${noRecipients ? ' iss-needs' : ''}`}
            aria-label={notifyLabel}
            onClick={() => setRecipientsOpen(true)}
          >
            <Settings width={16} height={16} aria-hidden />
            <span className="hidden sm:inline">{notifyLabel}</span>
          </button>
        </header>

        {listError ? <div role="alert" className="iss-error-box px-3 py-2 text-sm">{s.errList}</div> : null}
        {opError ? <div role="alert" className="iss-error-box px-3 py-2 text-sm">{opError}</div> : null}

        {!mid ? (
          <div role="tablist" aria-label={s.paneSwitchLabel} className="grid grid-cols-2 gap-2">
            <button type="button" role="tab" aria-selected={pane === 'new'} className="iss-tab min-h-[44px]" onClick={() => setPane('new')}>
              {s.paneNew}
            </button>
            <button type="button" role="tab" aria-selected={pane === 'list'} className="iss-tab min-h-[44px]" onClick={() => setPane('list')}>
              {s.paneList(openCount)}
            </button>
          </div>
        ) : null}

        <div className={gridClass}>
          <div hidden={!showNew} className="min-w-0">
            {created ? (
              <CreateSuccess
                s={s}
                lang={lang}
                issueKey={created.issueKey}
                notifiedEmails={created.notified}
                directory={directory}
                onView={() => {
                  if (newIssueId) select(newIssueId);
                  setPane('list');
                }}
                onNew={() => setCreated(null)}
              />
            ) : user ? (
              <CreateForm
                active={showNew}
                s={s}
                lang={lang}
                draftKey={`issue_draft_${(user.email || user.id).toLowerCase()}`}
                author={{ email: me ?? user.email, name: user.displayName || null }}
                getAccessToken={() => getAccessToken()}
                onCreated={onCreated}
              />
            ) : null}
          </div>

          <div hidden={!showList} className="min-w-0">
            <ListPanel
              s={s}
              lang={lang}
              issues={issues}
              loading={loading}
              me={me}
              directory={directory}
              filter={filter}
              onFilter={setFilter}
              selectedId={selectedId}
              newIssueId={newIssueId}
              onSelect={(id) => select(id)}
            />
          </div>

          {wide ? (
            <aside className="iss-card sticky top-4 flex max-h-[calc(100vh-2rem)] min-w-0 flex-col overflow-hidden" aria-labelledby={selected ? 'iss-panel-title' : undefined}>
              {panel ?? <TriageEmpty s={s} />}
            </aside>
          ) : null}
        </div>
      </div>

      <SlideOver open={!wide && panelOpen && !!selected} onClose={() => setPanelOpen(false)} s={s}>
        {panel}
      </SlideOver>

      <RecipientsDialog
        open={recipientsOpen}
        onClose={() => setRecipientsOpen(false)}
        onSaved={setRecipients}
        s={s}
        canNotify={canNotify}
        directory={directory}
      />

      <ConfirmDialog
        open={confirmOpen && !!selected}
        title={s.confirmTitle}
        message={selected ? s.deleteConfirm(selected.issueKey) : ''}
        confirmLabel={s.delete}
        cancelLabel={s.cancel}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
