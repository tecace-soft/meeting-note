// F2: list views, filters, counts and purpose groups (spec section 6.5).

import { PURPOSE_ORDER, isOpenStatus } from './constants';
import type { Issue, PurposeId } from './types';

export type ListView = 'open' | 'untriaged' | 'mine' | 'all';
export const VIEW_ORDER: readonly ListView[] = ['open', 'untriaged', 'mine', 'all'];

/** 'all' | 'none' (unassigned) | an assignee email. */
export type AssigneeFilter = string;

export interface ListFilter {
  view: ListView;
  query: string;
  assignee: AssigneeFilter;
}

// NOTE: same(null, null) = false. Unlike sameEmail in mailDecision.ts (null == null).
// Do not merge the two.
export const same = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const matchesView = (i: Issue, view: ListView, me: string | null): boolean =>
  view === 'open' ? isOpenStatus(i.status)
    : view === 'untriaged' ? !i.triagedAt && isOpenStatus(i.status)
      : view === 'mine' ? same(i.assigneeEmail, me) && isOpenStatus(i.status) // finished work does not count
        : true;

export const matchesQuery = (i: Issue, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return !s || [i.title, i.issueKey, i.authorName ?? '', i.authorEmail, i.description].some((f) => f.toLowerCase().includes(s));
};

export const matchesAssignee = (i: Issue, a: AssigneeFilter): boolean =>
  a === 'all' ? true : a === 'none' ? !i.assigneeEmail : same(i.assigneeEmail, a);

export const filterIssues = (list: Issue[], f: ListFilter, me: string | null): Issue[] =>
  list.filter((i) => matchesView(i, f.view, me) && matchesQuery(i, f.query) && matchesAssignee(i, f.assignee));

/** Tab counts: always over the whole list, independent of query / assignee filter. */
export const countByView = (list: Issue[], me: string | null): Record<ListView, number> => ({
  open: list.filter((i) => matchesView(i, 'open', me)).length,
  untriaged: list.filter((i) => matchesView(i, 'untriaged', me)).length,
  mine: list.filter((i) => matchesView(i, 'mine', me)).length,
  all: list.length,
});

/** Newest first. */
export const sortByCreatedDesc = (list: Issue[]): Issue[] =>
  [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

/** Purpose groups in PURPOSE_ORDER; empty groups are dropped (LIST-4). */
export const groupByPurpose = (list: Issue[]): { purpose: PurposeId; items: Issue[] }[] =>
  PURPOSE_ORDER
    .map((purpose) => ({ purpose, items: sortByCreatedDesc(list.filter((i) => i.purpose === purpose)) }))
    .filter((g) => g.items.length > 0);
