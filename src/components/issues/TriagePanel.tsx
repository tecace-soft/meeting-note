// F2: triage panel (TRIAGE-*, AI-5..7, DELETE-1). Used as the fixed column on wide screens
// and inside the slide-over otherwise; the draft lives on the board (TRIAGE-5).

import { useState } from 'react';
import { CircleCheck, ChevronDown, EditPencil01, Star } from 'react-coolicons';
import type { AppLanguage } from '../../context/LanguageContext';
import {
  AREA_OPTIONS, PRIORITY_ORDER, PURPOSE_ORDER, STATUS_ORDER, areaLabel, personLabel, priorityLabel, purposeLabel, statusLabel,
} from '../../lib/issues/constants';
import { headerDate } from '../../lib/issues/mailDecision';
import type { IssueStrings } from '../../lib/issues/strings';
import { applySuggestion, suggestionApplied } from '../../lib/issues/triageDraft';
import type { DirectoryUser, Issue, IssueResolution, TriagePatch } from '../../lib/issues/types';
import { AttachmentThumbs, StatusBadge } from './parts';

export interface TriageActions {
  saving: boolean;
  saveResult: string | null;
  aiRunning: boolean;
  aiError: string | null;
  onSave: () => void;
  onDelete: () => void;
  onGenerate: () => void;
}

export function TriageEmpty({ s }: { s: IssueStrings }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <EditPencil01 width={28} height={28} aria-hidden className="iss-text-2" />
      <p className="text-sm iss-text-2">{s.panelEmpty}</p>
    </div>
  );
}

export function TriagePanel({
  s, lang, issue, draft, setDraft, canTriage, isAuthor, directory, urls, actions, headingId,
}: {
  s: IssueStrings;
  lang: AppLanguage;
  issue: Issue;
  draft: TriagePatch | null;
  setDraft: (d: TriagePatch) => void;
  canTriage: boolean;
  isAuthor: boolean;
  directory: DirectoryUser[];
  urls: Record<string, string>;
  actions: TriageActions;
  headingId: string;
}) {
  const disabled = !canTriage || !draft;
  const set = (patch: Partial<TriagePatch>) => {
    if (draft) setDraft({ ...draft, ...patch });
  };
  // triaged_by is an email (legacy rows may hold a display name).
  const triagedBy = issue.triagedBy;
  const triagedByName = triagedBy
    ? directory.find((d) => d.email === triagedBy.toLowerCase())?.displayName ?? (triagedBy.includes('@') ? triagedBy.split('@')[0] : triagedBy)
    : null;
  const assigneeOptions = [...directory];
  if (draft?.assigneeEmail && !assigneeOptions.some((d) => d.email === draft.assigneeEmail?.toLowerCase())) {
    assigneeOptions.push({ email: draft.assigneeEmail.toLowerCase(), displayName: draft.assigneeName, isAdmin: false });
  }
  const showSaveBar = canTriage || isAuthor || !!actions.saveResult;
  const areaValue = draft?.area ?? issue.area;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (canTriage && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          actions.onSave();
        }
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="iss-mono text-xs iss-text-2">{issue.issueKey}</span>
            <StatusBadge status={issue.status} lang={lang} />
          </div>
          <h2 id={headingId} className="text-base font-semibold">{issue.title}</h2>
          <p className="text-xs iss-text-2">
            {[personLabel(issue.authorName, issue.authorEmail), headerDate(issue.createdAt, lang), triagedByName ? s.triagedBy(triagedByName) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>

        <p className="whitespace-pre-wrap text-sm">{issue.description}</p>

        <AttachmentThumbs attachments={issue.attachments} urls={urls} layout="row" />

        {!canTriage ? <p className="iss-warn-box px-3 py-2 text-sm">{s.noPermission}</p> : null}

        {issue.aiSuggestion ? (
          <div className="iss-suggest flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1 text-sm font-semibold">
                <Star width={16} height={16} aria-hidden />
                {s.suggestTitle}
              </span>
              {canTriage && draft ? (
                <button
                  type="button"
                  className="iss-btn px-2 py-1 text-xs"
                  disabled={suggestionApplied(draft, issue)}
                  onClick={() => setDraft(applySuggestion(draft, issue))}
                >
                  {suggestionApplied(draft, issue) ? s.suggestApplied : s.suggestApply}
                </button>
              ) : null}
            </div>
            <p className="text-sm">
              {purposeLabel(issue.aiSuggestion.purpose, lang)} · {areaLabel(issue.aiSuggestion.area, lang)} ·{' '}
              <strong>{priorityLabel(issue.aiSuggestion.priority, lang)}</strong>
            </p>
            {issue.aiSuggestion.reason ? <p className="text-xs iss-text-2">{issue.aiSuggestion.reason}</p> : null}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field id="iss-t-purpose" label={s.fieldKind}>
            <select id="iss-t-purpose" className="iss-input" disabled={disabled} value={draft?.purpose ?? issue.purpose}
              onChange={(e) => set({ purpose: e.target.value as TriagePatch['purpose'] })}>
              {PURPOSE_ORDER.map((p) => <option key={p} value={p}>{purposeLabel(p, lang)}</option>)}
            </select>
          </Field>
          <Field id="iss-t-area" label={s.fieldScreen}>
            <select id="iss-t-area" className="iss-input" disabled={disabled} value={areaValue} onChange={(e) => set({ area: e.target.value })}>
              {AREA_OPTIONS.filter((a) => a.selectable || a.id === areaValue).map((a) => <option key={a.id} value={a.id}>{a[lang]}</option>)}
              {AREA_OPTIONS.some((a) => a.id === areaValue) ? null : <option value={areaValue}>{areaValue}</option>}
            </select>
          </Field>
          <Field id="iss-t-priority" label={s.fieldPriority}>
            <select id="iss-t-priority" className="iss-input" disabled={disabled} value={draft?.priority ?? issue.priority}
              onChange={(e) => set({ priority: e.target.value as TriagePatch['priority'] })}>
              {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{priorityLabel(p, lang)}</option>)}
            </select>
          </Field>
          <Field id="iss-t-status" label={s.fieldStatus}>
            <select id="iss-t-status" className="iss-input" disabled={disabled} value={draft?.status ?? issue.status}
              onChange={(e) => set({ status: e.target.value as TriagePatch['status'] })}>
              {STATUS_ORDER.map((st) => <option key={st} value={st}>{statusLabel(st, lang)}</option>)}
            </select>
          </Field>
        </div>

        <Field id="iss-t-assignee" label={s.fieldAssignee}>
          <select
            id="iss-t-assignee"
            className="iss-input"
            disabled={disabled}
            value={draft?.assigneeEmail?.toLowerCase() ?? ''}
            onChange={(e) => {
              const email = e.target.value || null;
              const person = assigneeOptions.find((d) => d.email === email);
              set({ assigneeEmail: email, assigneeName: email ? personLabel(person?.displayName ?? null, email) : null });
            }}
          >
            <option value="">{s.unassigned}</option>
            {/* Name AND email, so two people with the same display name stay distinguishable. */}
            {assigneeOptions.map((u) => <option key={u.email} value={u.email}>{`${personLabel(u.displayName, u.email)} (${u.email})`}</option>)}
          </select>
        </Field>

        <div className="flex flex-col gap-1">
          <label htmlFor="iss-t-note" className="text-sm font-medium">
            {s.fieldNote} <span className="text-xs font-normal iss-text-2">{s.fieldNoteHint}</span>
          </label>
          <textarea
            id="iss-t-note"
            className="iss-input min-h-[72px] resize-y"
            disabled={disabled}
            placeholder={s.fieldNotePlaceholder}
            value={draft?.triageNote ?? issue.triageNote ?? ''}
            onChange={(e) => set({ triageNote: e.target.value })}
          />
        </div>

        <ResolutionSection s={s} lang={lang} resolution={issue.resolution} generatedAt={issue.resolutionGeneratedAt} canTriage={canTriage} actions={actions} />
      </div>

      {showSaveBar ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t px-4 py-3" style={{ borderColor: 'var(--border-light)', background: 'var(--surface)' }}>
          {canTriage ? (
            <button type="button" className="iss-btn-primary" disabled={actions.saving || !draft} onClick={actions.onSave}>
              {actions.saving ? s.saving : s.save}
            </button>
          ) : null}
          <span role="status" className="flex min-w-0 flex-1 items-center gap-1 text-xs iss-text-2">
            {actions.saveResult ? (
              <>
                <CircleCheck width={14} height={14} aria-hidden />
                {actions.saveResult}
              </>
            ) : canTriage ? s.saveHint : ''}
          </span>
          {isAuthor ? (
            <button type="button" className="iss-btn iss-btn-danger ml-auto" onClick={actions.onDelete}>{s.delete}</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function ResolutionSection({
  s, lang, resolution, generatedAt, canTriage, actions,
}: {
  s: IssueStrings;
  lang: AppLanguage;
  resolution: IssueResolution | null;
  generatedAt: string | null;
  canTriage: boolean;
  actions: TriageActions;
}) {
  const [open, setOpen] = useState(false);
  const button = canTriage ? (
    <button type="button" className="iss-btn self-start" disabled={actions.aiRunning} onClick={actions.onGenerate}>
      {actions.aiRunning ? s.aiRunning : resolution ? s.aiRegenerate : s.aiGenerate}
    </button>
  ) : null;
  const error = actions.aiError ? <p role="alert" className="text-sm iss-danger">{actions.aiError}</p> : null;

  if (!resolution) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm iss-text-2">{s.aiIntro}</p>
        {button}
        {error}
      </div>
    );
  }
  const lists: [string, string[]][] = [
    [s.aiRootCauses, resolution.rootCauses],
    [s.aiChecks, resolution.checks],
    [s.aiFixPlan, resolution.fixPlan],
    [s.aiVerification, resolution.verification],
  ];
  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-light)' }}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        aria-controls="iss-ai-body"
        onClick={() => setOpen((v) => !v)}
      >
        <Star width={16} height={16} aria-hidden />
        <span className="text-sm font-semibold">{s.aiTitle}</span>
        <span className="min-w-0 flex-1 truncate text-sm iss-text-2">{resolution.summary}</span>
        <span className={`iss-badge iss-c-${resolution.confidence}`}>{s.aiConfidence[resolution.confidence]}</span>
        <ChevronDown width={16} height={16} aria-hidden className={`iss-chevron${open ? ' iss-chevron-open' : ''}`} />
      </button>
      <div id="iss-ai-body" hidden={!open} className={`${open ? 'flex' : 'hidden'} flex-col gap-3 border-t px-3 py-3`} style={{ borderColor: 'var(--border-light)' }}>
        <p className="text-sm font-medium">{resolution.summary}</p>
        {lists.map(([label, items]) => (
          <div key={label}>
            <p className="text-xs font-semibold iss-text-2">{label}</p>
            <ol className="ml-5 list-decimal text-sm">
              {items.map((item, idx) => <li key={idx}>{item}</li>)}
            </ol>
          </div>
        ))}
        {generatedAt ? <p className="text-xs iss-text-2">{s.aiGeneratedAt(headerDate(generatedAt, lang))}</p> : null}
        {button}
      </div>
      {error ? <div className="px-3 pb-3">{error}</div> : null}
    </div>
  );
}
