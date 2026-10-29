import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteSharingChangedError } from '../lib/notes/repository';
import { SpeakerNoteShareActions, type SpeakerShareAssignment } from './SpeakerNoteShareActions';

vi.mock('../config/supabaseConfig', () => ({ supabase: {} }));
const h = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('../lib/notes/repository', async (original) => ({
  ...await original<typeof import('../lib/notes/repository')>(),
  getNoteSharing: (...args: unknown[]) => h.read(...args),
  setNoteSharedUsersAsOwner: (...args: unknown[]) => h.write(...args),
}));
const ASSIGNMENTS: SpeakerShareAssignment[] = [{ speakerKey: 'Speaker A', name: 'Colleague', microsoftId: 'colleague-oid', noteId: 'n1', userId: 'owner' }];
const owner = (users = ['legacy']) => ({ user_id: 'owner', shared_users: users });
function mount(assignments = ASSIGNMENTS) {
  const onNoteShared = vi.fn(); const onSelectSharingTarget = vi.fn(); const onDismiss = vi.fn();
  return { ...render(<SpeakerNoteShareActions noteId="n1" userId="owner" assignments={assignments}
    onDismiss={onDismiss} onNoteShared={onNoteShared} onSelectSharingTarget={onSelectSharingTarget} />), onNoteShared, onSelectSharingTarget, onDismiss };
}
beforeEach(() => { h.read.mockReset().mockResolvedValue(owner()); h.write.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

describe('explicit speaker sharing ownership and lifecycle', () => {
  it('does no write before a click, blocks duplicate clicks and preserves freshly read shares', async () => {
    const { onNoteShared } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    expect(h.write).not.toHaveBeenCalled();
    h.read.mockResolvedValue(owner(['legacy', 'new-recipient']));
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ noteId: 'n1', userId: 'owner', sharedUsers: ['legacy', 'new-recipient', 'colleague-oid'], expectedSharedUsers: ['legacy', 'new-recipient'] });
    expect(onNoteShared).toHaveBeenCalledExactlyOnceWith(['legacy', 'new-recipient', 'colleague-oid']);
  }, 5000);

  it('stops after three conflicts and reports failure without a success callback', async () => {
    h.write.mockRejectedValue(new NoteSharingChangedError());
    const { onNoteShared } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'shareNoteWithThisPerson' }));
    await screen.findByText(/Could not share/);
    expect(h.write).toHaveBeenCalledTimes(3);
    expect(h.read).toHaveBeenCalledTimes(4);
    expect(onNoteShared).not.toHaveBeenCalled();
    expect(screen.queryByText('noteAlreadyShared')).not.toBeInTheDocument();
  }, 5000);

  it('does not retry a database failure', async () => {
    h.write.mockRejectedValue(new Error('Sharing database down'));
    const { onNoteShared } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'shareNoteWithThisPerson' }));
    await screen.findByText('Sharing database down');
    expect(h.write).toHaveBeenCalledTimes(1); expect(onNoteShared).not.toHaveBeenCalled();
  }, 5000);

  it('re-checks ownership after a conflict before attempting another write', async () => {
    const { onNoteShared } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.read.mockResolvedValueOnce(owner()).mockResolvedValue({ user_id: 'other-owner', shared_users: [] });
    h.write.mockRejectedValue(new NoteSharingChangedError());
    fireEvent.click(button);
    await screen.findByText('Only the note owner can share this note.');
    expect(h.write).toHaveBeenCalledTimes(1); expect(onNoteShared).not.toHaveBeenCalled();
  }, 5000);

  it('does not write again when another tab already added the chosen recipient', async () => {
    const { onNoteShared } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.read.mockResolvedValueOnce(owner()).mockResolvedValue(owner(['other-tab', 'colleague-oid']));
    h.write.mockRejectedValue(new NoteSharingChangedError());
    fireEvent.click(button);
    await screen.findByText('noteAlreadyShared');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(onNoteShared).toHaveBeenCalledWith(['other-tab', 'colleague-oid']);
  }, 5000);

  it('shows an existing share without writing or revoking it', async () => {
    h.read.mockResolvedValue(owner(['legacy', 'colleague-oid']));
    mount();
    await screen.findByText('noteAlreadyShared');
    expect(screen.queryByRole('button', { name: 'shareNoteWithThisPerson' })).not.toBeInTheDocument();
    expect(h.write).not.toHaveBeenCalled();
  }, 5000);

  it('rejects a non-owner before offering share or target selection', async () => {
    h.read.mockResolvedValue({ user_id: 'someone-else', shared_users: [] });
    mount();
    await screen.findByText('Only the note owner can share this note.');
    expect(screen.queryByRole('button', { name: 'shareNoteWithThisPerson' })).not.toBeInTheDocument();
    expect(h.write).not.toHaveBeenCalled();
  }, 5000);

  it('re-checks ownership at click time and never writes after losing it', async () => {
    const { onNoteShared } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    h.read.mockResolvedValue({ user_id: 'someone-else', shared_users: [] });
    fireEvent.click(button);
    await screen.findByText('Only the note owner can share this note.');
    expect(h.write).not.toHaveBeenCalled(); expect(onNoteShared).not.toHaveBeenCalled();
  }, 5000);

  it('read failure is visible and retry cannot write or claim success', async () => {
    h.read.mockRejectedValue(new Error('Sharing read failed'));
    mount();
    await screen.findByText('Sharing read failed');
    expect(h.write).not.toHaveBeenCalled();
    h.read.mockResolvedValue(owner());
    fireEvent.click(screen.getByRole('button', { name: 'retryNoteSharing' }));
    await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    expect(h.write).not.toHaveBeenCalled();
  }, 5000);

  it('unknown identity refreshes the share list and opens the existing dialog without writing', async () => {
    const { onNoteShared, onSelectSharingTarget } = mount([{ ...ASSIGNMENTS[0], microsoftId: null }]);
    fireEvent.click(await screen.findByRole('button', { name: 'selectNoteSharingTarget' }));
    await waitFor(() => expect(onSelectSharingTarget).toHaveBeenCalledTimes(1));
    expect(onNoteShared).toHaveBeenCalledWith(['legacy']); expect(h.write).not.toHaveBeenCalled();
  }, 5000);

  it('does not share a previous assignee when the name changes during the click-time read', async () => {
    const { rerender } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    let release!: (value: ReturnType<typeof owner>) => void;
    const pending = new Promise<ReturnType<typeof owner>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture read deadline')), 1000);
      release = (value) => { clearTimeout(timer); resolve(value); };
    });
    h.read.mockReturnValueOnce(pending);
    fireEvent.click(button);
    rerender(<SpeakerNoteShareActions noteId="n1" userId="owner"
      assignments={[{ ...ASSIGNMENTS[0], name: 'New colleague', microsoftId: 'new-oid' }]} onDismiss={() => undefined} />);
    release(owner());
    await pending;
    await screen.findByText('New colleague · speakerNameSaved');
    expect(h.write).not.toHaveBeenCalled();
  }, 5000);

  it('ignores a click-time read arriving after unmount', async () => {
    const { unmount, onNoteShared } = mount();
    const button = await screen.findByRole('button', { name: 'shareNoteWithThisPerson' });
    // The pending I/O itself also has a bound, not only the enclosing test deadline.
    let release!: (value: ReturnType<typeof owner>) => void;
    const pending = new Promise<ReturnType<typeof owner>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture read deadline')), 1000);
      release = (value) => { clearTimeout(timer); resolve(value); };
    });
    h.read.mockReturnValue(pending);
    fireEvent.click(button);
    unmount(); release(owner());
    await pending;
    expect(h.write).not.toHaveBeenCalled(); expect(onNoteShared).not.toHaveBeenCalled();
  }, 5000);
});
