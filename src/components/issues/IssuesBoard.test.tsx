// UI behaviour of the issue board (spec 12.2 items that can run in jsdom). The data and
// server layers are mocked: these tests check what the screen does, not Supabase.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../../lib/issues/types';

const ADMIN_ID = '31d79bfe-2488-47c2-aa45-949375e93bde';
const auth = { id: 'user-1', email: 'me@tecace.com', name: 'Me', ready: true };

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.ready ? { id: auth.id, displayName: auth.name, email: auth.email, microsoftAccountName: auth.name } : null,
    isAuthenticated: auth.ready,
    isLoading: !auth.ready,
    verifiedEmail: auth.ready ? auth.email : null,
    getAccessToken: async () => 'token',
  }),
}));
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ appLanguage: 'ko' }) }));

const service = vi.hoisted(() => ({
  listIssues: vi.fn(),
  createIssue: vi.fn(),
  saveTriage: vi.fn(),
  saveResolution: vi.fn(),
  softDeleteIssue: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  signAttachmentUrls: vi.fn(async () => ({})),
  fetchRecipients: vi.fn(async () => ({ status: 'ok', recipients: [{ email: 'andrewyoo@tecace.com', addedBy: null, addedAt: null }] })),
  resolveNotifyEmails: vi.fn(async () => ['andrewyoo@tecace.com']),
  saveRecipients: vi.fn(),
  fetchDirectory: vi.fn(async () => [
    { email: 'andrewyoo@tecace.com', displayName: 'Andrew Yoo', isAdmin: true },
    { email: 'b@tecace.com', displayName: 'User B', isAdmin: false },
  ]),
}));
vi.mock('../../lib/issues/service', async (importOriginal) => ({ ...(await importOriginal<object>()), ...service }));

const server = vi.hoisted(() => ({
  notifyCreated: vi.fn(async () => ['andrewyoo@tecace.com']),
  notifyAfterTriage: vi.fn(),
  generateResolution: vi.fn(),
}));
vi.mock('../../lib/issues/serverApi', async (importOriginal) => ({ ...(await importOriginal<object>()), ...server }));

import Issues from '../../pages/Issues';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'i1', issueKey: 'FB-20261014-AAAA0001', title: '저장 버튼 오류', description: '눌러도 반응 없음',
  purpose: 'bug', area: 'meeting-note', status: 'OPEN', priority: 'P2', severity: 'High',
  assigneeEmail: null, assigneeName: null, triageNote: null,
  aiSuggestion: { purpose: 'bug', area: 'meeting-note', priority: 'P2', severity: 'High', reason: '오류를 뜻하는 표현이 있어 버그로 분류했습니다.' },
  attachments: [], resolution: null, resolutionGeneratedAt: null, resolutionModel: null,
  authorEmail: 'someone@tecace.com', authorName: 'Someone', triagedAt: null, triagedBy: null,
  createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T01:00:00Z', ...over,
});

function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
    return { matches: width >= min, media: query, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const renderBoard = () => render(<MemoryRouter initialEntries={['/issues']}><Issues /></MemoryRouter>);

beforeEach(() => {
  window.localStorage.clear();
  setViewport(1600);
  auth.id = 'user-1';
  auth.email = 'me@tecace.com';
  auth.ready = true;
  service.listIssues.mockResolvedValue([issue()]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('auth timing (prod bug 2026-10-15)', () => {
  it('does not read before auth is ready, then loads once the user is signed in', async () => {
    auth.ready = false;
    const view = renderBoard();
    await new Promise((r) => setTimeout(r, 0));
    expect(service.listIssues).not.toHaveBeenCalled();
    expect(service.fetchDirectory).not.toHaveBeenCalled();
    expect(service.fetchRecipients).not.toHaveBeenCalled();
    auth.ready = true;
    view.rerender(<MemoryRouter initialEntries={['/issues']}><Issues /></MemoryRouter>);
    expect(await screen.findByText('저장 버튼 오류')).toBeInTheDocument();
    expect(service.fetchDirectory).toHaveBeenCalledTimes(1);
    expect(service.fetchRecipients).toHaveBeenCalledTimes(1);
  });
});

describe('create form', () => {
  it('highlights no purpose when empty, then follows the suggestion with a reason line', async () => {
    renderBoard();
    const bug = screen.getByRole('button', { name: '버그' });
    expect(bug).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '로그인이 전혀 안 돼요' } });
    expect(bug).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/다르면 바꿔 주세요\.$/)).toBeInTheDocument();
    expect((screen.getByLabelText('어느 화면인가요?') as HTMLSelectElement).value).toBe('settings');
  });

  it('keeps a manual purpose and hides the reason line', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '질문' }));
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '에러가 나요' } });
    expect(screen.getByRole('button', { name: '질문' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/다르면 바꿔 주세요/)).toBeNull();
  });

  it('refuses an empty submit with the spec message', async () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '이슈 등록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('제목과 설명을 모두 입력해 주세요.');
    expect(service.createIssue).not.toHaveBeenCalled();
  });

  it('autosaves after 500 ms, restores with a banner, and [새로 작성] clears it', async () => {
    vi.useFakeTimers();
    const first = renderBoard();
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '쓰던 제목' } });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();
    expect(window.localStorage.getItem('issue_draft_me@tecace.com')).toContain('쓰던 제목');
    first.unmount();
    renderBoard();
    expect(screen.getByText('쓰던 내용을 불러왔습니다.')).toBeInTheDocument();
    expect(screen.getByLabelText('제목')).toHaveValue('쓰던 제목');
    fireEvent.click(screen.getByRole('button', { name: '새로 작성' }));
    expect(screen.getByLabelText('제목')).toHaveValue('');
    expect(window.localStorage.getItem('issue_draft_me@tecace.com')).toBeNull();
  });

  it('submits suggestion values, shows the completion screen, highlights and opens the new issue', async () => {
    const created = issue({ id: 'new1', issueKey: 'FB-20261014-BBBB0002', title: '로그인이 전혀 안 돼요', authorEmail: 'me@tecace.com', createdAt: '2026-10-14T02:00:00Z' });
    service.createIssue.mockResolvedValue(created);
    renderBoard();
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '로그인이 전혀 안 돼요' } });
    fireEvent.change(screen.getByLabelText('무엇을 하다가, 무엇이 일어났나요?'), { target: { value: '아침부터' } });
    service.listIssues.mockResolvedValue([created, issue()]);
    fireEvent.click(screen.getByRole('button', { name: '이슈 등록' }));
    const status = await screen.findByText('FB-20261014-BBBB0002');
    expect(service.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'bug', area: 'settings', priority: 'P1',
      aiSuggestion: expect.objectContaining({ purpose: 'bug', priority: 'P1', severity: 'Critical' }),
    }));
    expect(status.closest('[role="status"]')).toHaveTextContent('Andrew Yoo에게 알림 메일을 보냈습니다.');
    await waitFor(() => expect(document.querySelector('[data-issue-id="new1"]')).toHaveClass('iss-item-new'));
    fireEvent.click(screen.getByRole('button', { name: '목록에서 보기' }));
    expect(document.querySelector('[data-issue-id="new1"]')).toHaveAttribute('aria-current', 'true');
  });
});

describe('create notify failure (CREATE-11)', () => {
  it('does not claim a mail was sent when /issue-notify fails', async () => {
    server.notifyCreated.mockResolvedValueOnce(null as unknown as string[]);
    service.createIssue.mockResolvedValue(issue({ id: 'n2', issueKey: 'FB-20261015-CCCC0003', authorEmail: 'me@tecace.com' }));
    renderBoard();
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '버튼 오류' } });
    fireEvent.change(screen.getByLabelText('무엇을 하다가, 무엇이 일어났나요?'), { target: { value: '설명' } });
    fireEvent.click(screen.getByRole('button', { name: '이슈 등록' }));
    const key = await screen.findByText('FB-20261015-CCCC0003');
    const status = key.closest('[role="status"]');
    expect(status).toHaveTextContent('알림 메일을 보내지 못했습니다. 처리되면 이 목록에서 확인할 수 있어요.');
    expect(status).not.toHaveTextContent('보냈습니다');
  });
});

describe('attachments', () => {
  const pasteFiles = (files: File[]) => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files, items: [] };
    act(() => {
      document.getElementById('iss-desc')?.dispatchEvent(event);
    });
    return event;
  };

  it('pasting an image anywhere uploads it as 스크린샷-1.png; [빼기] is visible and deletes it', async () => {
    service.uploadAttachment.mockImplementation(async (_file: File, name: string) => ({ name, path: 'screenshots/1-abc.png', type: 'image/png' }));
    renderBoard();
    const event = pasteFiles([new File(['x'], 'image.png', { type: 'image/png' })]);
    expect(event.defaultPrevented).toBe(true);
    const remove = await screen.findByRole('button', { name: '스크린샷-1.png 빼기' });
    expect(remove).toBeVisible();
    fireEvent.click(remove);
    expect(service.deleteAttachment).toHaveBeenCalledWith('screenshots/1-abc.png');
  });

  it('a text paste is left alone', () => {
    renderBoard();
    expect(pasteFiles([]).defaultPrevented).toBe(false);
    expect(service.uploadAttachment).not.toHaveBeenCalled();
  });

  it('an 11 MB file is skipped with the spec message', async () => {
    const { AttachmentTooLargeError } = await vi.importActual<typeof import('../../lib/issues/service')>('../../lib/issues/service');
    service.uploadAttachment.mockImplementation(async (_file: File, name: string) => {
      throw new AttachmentTooLargeError(name);
    });
    renderBoard();
    pasteFiles([new File(['x'], 'big.png', { type: 'image/png' })]);
    expect(await screen.findByRole('alert')).toHaveTextContent('big.png 은 10MB 를 넘어 건너뛰었습니다.');
  });
});

describe('list', () => {
  it('counts views over the whole list and shows the empty message', async () => {
    service.listIssues.mockResolvedValue([issue(), issue({ id: 'i2', status: 'DONE', assigneeEmail: 'me@tecace.com', triagedAt: '2026-10-14T03:00:00Z' })]);
    renderBoard();
    const tabs = await screen.findAllByRole('tab');
    await waitFor(() => expect(tabs.map((t) => t.textContent)).toEqual(['미종결1', '분류 필요1', '내 담당0', '전체2']));
    fireEvent.change(screen.getByLabelText('이슈 검색'), { target: { value: 'zzz' } });
    expect(screen.getByText('조건에 맞는 이슈가 없습니다.')).toBeInTheDocument();
  });
});

describe('triage panel', () => {
  it('without triage rights: notice, disabled inputs, no save / apply / AI, no save bar', async () => {
    renderBoard();
    fireEvent.click(await screen.findByText('저장 버튼 오류'));
    expect(screen.getByText(/분류·담당자 지정은 관리자 권한이 있는 사람이 합니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('담당자')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull();
    expect(screen.queryByRole('button', { name: '제안 적용' })).toBeNull();
    expect(screen.queryByRole('button', { name: '해결책 생성' })).toBeNull();
    expect(screen.queryByText('Ctrl+Enter 로 저장')).toBeNull();
    expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
  });

  it('admin: apply suggestion, save with Ctrl+Enter, result line and assignment mail', async () => {
    auth.id = ADMIN_ID;
    auth.email = 'andrewyoo@tecace.com';
    renderBoard();
    fireEvent.click(await screen.findByText('저장 버튼 오류'));
    expect(screen.getByRole('button', { name: '적용됨' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'User B (b@tecace.com)' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('담당자')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('담당자'), { target: { value: 'b@tecace.com' } });
    service.saveTriage.mockResolvedValue(issue({ assigneeEmail: 'b@tecace.com', assigneeName: 'User B', triagedAt: '2026-10-14T04:00:00Z', updatedAt: '2026-10-14T04:00:00Z' }));
    fireEvent.keyDown(screen.getByLabelText('담당자'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.getByText(/저장됨 \d\d:\d\d · User B에게 배정 메일/)).toBeInTheDocument());
    expect(service.saveTriage).toHaveBeenCalledWith('i1', expect.objectContaining({ assigneeEmail: 'b@tecace.com' }), 'andrewyoo@tecace.com');
    expect(server.notifyAfterTriage).toHaveBeenCalledWith('assigned', 'FB-20261014-AAAA0001', expect.any(Function));
  });

  it('author deletes after the spec confirmation', async () => {
    service.listIssues.mockResolvedValue([issue({ authorEmail: 'Me@tecace.com' })]);
    renderBoard();
    fireEvent.click(await screen.findByText('저장 버튼 오류'));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('FB-20261014-AAAA0001 이슈를 삭제할까요?');
    expect(dialog).not.toHaveTextContent('되돌릴');
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(service.softDeleteIssue).toHaveBeenCalled());
  });

  it('below 1536px the panel is a modal slide-over that closes on Escape', async () => {
    setViewport(1300);
    renderBoard();
    const item = await screen.findByText('저장 버튼 오류');
    fireEvent.click(item);
    const dialog = screen.getByRole('dialog', { name: '이슈 분류' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '이슈 분류' })).toBeNull();
  });

  it('below 1280px shows the pane switch with the open count', async () => {
    setViewport(390);
    renderBoard();
    await waitFor(() => expect(screen.getByRole('tab', { name: '목록 · 1' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: '새 이슈' })).toHaveAttribute('aria-selected', 'true');
  });
});
