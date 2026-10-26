import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult, RecordedQuery } from '../test/fakeSupabase';

const stable = vi.hoisted(() => ({
  auth: { user: { id: 'user-1', displayName: 'User One' } as { id: string; displayName: string } | null, logout: () => {}, isAuthenticated: true },
  language: { appLanguage: 'en', t: (key: string) => key },
  theme: { theme: 'light', toggleTheme: () => {} },
  noteError: null as { message: string } | null,
  fake: null as unknown,
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => stable.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => stable.language }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => stable.theme }));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase((q: RecordedQuery): FakeResult =>
    q.table === 'note' ? { data: [{ id: 'n1', name: 'Sidebar note' }], error: stable.noteError } : { data: [] });
  stable.fake = fake;
  return { supabase: fake.client };
});
import AppSidebar from './AppSidebar';

const fake = () => stable.fake as ReturnType<typeof createFakeSupabase>;
const noteQueries = () => fake().queries.filter((q) => q.table === 'note');
beforeEach(() => { fake().queries.length = 0; stable.noteError = null; stable.auth = { ...stable.auth, user: { id: 'user-1', displayName: 'User One' }, isAuthenticated: true }; });
afterEach(cleanup);
const mount = () => render(<MemoryRouter initialEntries={['/history']}><AppSidebar collapsed={false} onToggleCollapsed={() => {}} onExpandSidebar={() => {}} /></MemoryRouter>);

describe('AppSidebar note list read contract', () => {
  it('loads owned and directly shared notes newest first', async () => {
    mount();
    await waitFor(() => expect(noteQueries()).toHaveLength(1));
    expect(noteQueries()[0].calls).toEqual([['select', '*'], ['or', 'user_id.eq.user-1,shared_users.cs.{user-1}'], ['order', 'created_at', { ascending: false }]]);
  });
  it('does not query notes when signed out', async () => {
    stable.auth = { ...stable.auth, user: null, isAuthenticated: false };
    mount();
    await Promise.resolve();
    expect(noteQueries()).toHaveLength(0);
  });
  it('survives a note query error without throwing', async () => {
    stable.noteError = { message: 'down' };
    mount();
    await waitFor(() => expect(noteQueries()).toHaveLength(1));
  });
});
