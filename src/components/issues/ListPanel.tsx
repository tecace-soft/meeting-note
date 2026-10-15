// F2: issue list card (LIST-*): view tabs with counts, search, assignee filter, purpose groups.

import { useState } from 'react';
import { ChevronDown, PaperclipAttechmentHorizontal, SearchMagnifyingGlass } from 'react-coolicons';
import type { AppLanguage } from '../../context/LanguageContext';
import { areaLabel, assigneeLabel, personLabel, purposeLabel } from '../../lib/issues/constants';
import { VIEW_ORDER, countByView, filterIssues, groupByPurpose, type ListFilter, type ListView } from '../../lib/issues/listFilter';
import { listDate } from '../../lib/issues/mailDecision';
import type { IssueStrings } from '../../lib/issues/strings';
import type { DirectoryUser, Issue, PurposeId } from '../../lib/issues/types';
import { NeedsTriageBadge, PriorityBadge, StatusBadge } from './parts';

export function ListPanel({
  s, lang, issues, loading, me, directory, filter, onFilter, selectedId, newIssueId, onSelect,
}: {
  s: IssueStrings;
  lang: AppLanguage;
  issues: Issue[];
  loading: boolean;
  me: string | null;
  directory: DirectoryUser[];
  filter: ListFilter;
  onFilter: (f: ListFilter) => void;
  selectedId: string | null;
  newIssueId: string | null;
  onSelect: (id: string, opener: HTMLElement) => void;
}) {
  const [collapsed, setCollapsed] = useState<Partial<Record<PurposeId, boolean>>>({});
  const counts = countByView(issues, me);
  const groups = groupByPurpose(filterIssues(issues, filter, me));
  const viewLabel: Record<ListView, string> = { open: s.viewOpen, untriaged: s.viewUntriaged, mine: s.viewMine, all: s.viewAll };

  return (
    <section className="iss-card flex min-w-0 flex-col gap-3 p-4" aria-labelledby="iss-list-title">
      <h2 id="iss-list-title" className="text-base font-semibold">{s.listTitle}</h2>

      <div role="tablist" aria-label={s.listTitle} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {VIEW_ORDER.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={filter.view === v}
            className="iss-tab"
            onClick={() => onFilter({ ...filter, view: v })}
          >
            <span>{viewLabel[v]}</span>
            <span className={`iss-count${v === 'untriaged' && counts.untriaged > 0 ? ' iss-count-warn' : ''}`}>{counts[v]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="iss-search" className="iss-sr-only">{s.searchLabel}</label>
          <SearchMagnifyingGlass width={16} height={16} aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 iss-text-2" />
          <input
            id="iss-search"
            type="search"
            className="iss-input iss-input-search"
            placeholder={s.searchPlaceholder}
            value={filter.query}
            onChange={(e) => onFilter({ ...filter, query: e.target.value })}
          />
        </div>
        <div className="flex-shrink-0 sm:w-48">
          <label htmlFor="iss-assignee-filter" className="iss-sr-only">{s.assigneeFilterLabel}</label>
          <select
            id="iss-assignee-filter"
            className="iss-input"
            value={filter.assignee}
            onChange={(e) => onFilter({ ...filter, assignee: e.target.value })}
          >
            <option value="all">{s.allAssignees}</option>
            <option value="none">{s.unassigned}</option>
            {directory.map((u) => <option key={u.email} value={u.email}>{personLabel(u.displayName, u.email)}</option>)}
          </select>
        </div>
      </div>

      {loading && issues.length === 0 ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="iss-skeleton" />
          <div className="iss-skeleton" />
          <div className="iss-skeleton" />
        </div>
      ) : groups.length === 0 ? (
        <p className="py-6 text-center text-sm iss-text-2">{s.listEmpty}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(({ purpose, items }) => {
            const open = !collapsed[purpose];
            const listId = `iss-group-${purpose}`;
            return (
              <div key={purpose}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 py-1 text-left text-sm font-semibold"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => setCollapsed((c) => ({ ...c, [purpose]: open }))}
                >
                  <ChevronDown width={16} height={16} aria-hidden className={`iss-chevron${open ? '' : ' -rotate-90'}`} />
                  {s.groupToggle(purposeLabel(purpose, lang), items.length)}
                </button>
                <ul id={listId} hidden={!open} className={`mt-1 flex-col gap-1 ${open ? 'flex' : 'hidden'}`}>
                  {items.map((i) => (
                    <li key={i.id}>
                      <IssueItem
                        s={s}
                        lang={lang}
                        issue={i}
                        selected={i.id === selectedId}
                        isNew={i.id === newIssueId}
                        onSelect={onSelect}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IssueItem({
  s, lang, issue, selected, isNew, onSelect,
}: {
  s: IssueStrings;
  lang: AppLanguage;
  issue: Issue;
  selected: boolean;
  isNew: boolean;
  onSelect: (id: string, opener: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      className={`iss-item flex flex-col gap-1${isNew ? ' iss-item-new' : ''}`}
      aria-current={selected ? 'true' : undefined}
      data-issue-id={issue.id}
      onClick={(e) => onSelect(issue.id, e.currentTarget)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <PriorityBadge priority={issue.priority} lang={lang} />
        <span className="truncate text-sm font-medium">{issue.title}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs iss-text-2">
        <StatusBadge status={issue.status} lang={lang} />
        {!issue.triagedAt ? <NeedsTriageBadge s={s} /> : null}
        <span>{areaLabel(issue.area, lang)}</span>
        {issue.attachments.length ? (
          <span className="inline-flex items-center gap-0.5" aria-label={s.attachmentCount(issue.attachments.length)}>
            <PaperclipAttechmentHorizontal width={14} height={14} aria-hidden />
            {issue.attachments.length}
          </span>
        ) : null}
        <span className="ml-auto">
          {s.meta(personLabel(issue.authorName, issue.authorEmail), listDate(issue.createdAt), assigneeLabel(issue, s.unassigned))}
        </span>
      </span>
    </button>
  );
}
