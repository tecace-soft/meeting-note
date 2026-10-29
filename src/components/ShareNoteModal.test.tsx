import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult } from '../test/fakeSupabase';

const fixture = vi.hoisted(() => ({ result: {} as unknown, fake: null as unknown }));
const stable = vi.hoisted(() => ({
  auth: { user: { id: 'owner-1' }, getAccessToken: async () => 'token' },
  language: { appLanguage: 'en', t: (key: string) => key },
  existing: ['x'],
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => stable.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => stable.language }));
vi.mock('../services/microsoftContacts', () => ({
  fetchTecAceContacts: async () => [{ id: 'c1', displayName: 'Contact One', email: 'one@example.test', userPrincipalName: 'one@example.test' }],
}));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase(() => fixture.result as FakeResult);
  fixture.fake = fake;
  return { supabase: fake.client };
});
import ShareNoteModal from './ShareNoteModal';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
beforeEach(() => { fake().queries.length = 0; fixture.result = { data: { id: 'n1' } }; });
afterEach(cleanup);

async function openAndSave(props: { onShared?: (...a: unknown[]) => void; onClose?: () => void } = {}) {
  render(<ShareNoteModal isOpen noteId="n1" existingSharedUserIds={stable.existing} onClose={props.onClose ?? (() => {})} onShared={props.onShared} />);
  fireEvent.click(await screen.findByText('Contact One'));
  const save = screen.getAllByRole('button').find((b) => /save|share/i.test(b.textContent ?? '') && !/Contact/.test(b.textContent ?? ''));
  fireEvent.click(save!);
}

describe('ShareNoteModal save call contract', () => {
  it('confirms an owner-scoped shared_users write, then notifies', async () => {
    const onShared = vi.fn(); const onClose = vi.fn();
    await openAndSave({ onShared, onClose });
    await waitFor(() => expect(onShared).toHaveBeenCalledWith('n1', ['x', 'c1']));
    expect(onClose).toHaveBeenCalled();
    expect(fake().queries).toEqual([{ table: 'note', calls: [['update', { shared_users: ['x', 'c1'] }], ['eq', 'id', 'n1'], ['eq', 'user_id', 'owner-1'], ['select', 'id'], ['maybeSingle']] }]);
  });
  it('keeps the dialog open and reports zero changed rows instead of claiming success', async () => {
    fixture.result = { data: null };
    const onShared = vi.fn(); const onClose = vi.fn();
    await openAndSave({ onShared, onClose });
    expect(await screen.findByText(/Could not share/)).toBeInTheDocument();
    expect(onShared).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('shows the generic fallback for a non-Error database error and does not notify', async () => {
    fixture.result = { error: { message: 'denied' } };
    const onShared = vi.fn();
    await openAndSave({ onShared });
    expect(await screen.findByText('Could not share this note.')).toBeInTheDocument();
    expect(onShared).not.toHaveBeenCalled();
  });
});
