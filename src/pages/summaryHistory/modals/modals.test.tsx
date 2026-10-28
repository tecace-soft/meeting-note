import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: true }));
vi.mock('../../../components/ShareNoteModal', () => ({
  default: (p: { isOpen: boolean; noteId: string | null; noteTitle?: string | null; existingSharedUserIds?: string[]; onClose: () => void }) => (
    <div data-testid="share" data-open={String(p.isOpen)}>
      {p.noteId}|{p.noteTitle}|{(p.existingSharedUserIds ?? []).join(',')}
      <button type="button" onClick={p.onClose}>
        share-close
      </button>
    </div>
  ),
}));
vi.mock('../../../components/MeetingKnowledgeModal', () => ({
  default: (p: { noteId: string; noteTitle?: string | null; onClose: () => void }) => (
    <div data-testid="knowledge">
      {p.noteId}|{p.noteTitle}
      <button type="button" onClick={p.onClose}>
        knowledge-close
      </button>
    </div>
  ),
}));

import { AddToProjectDialog } from './AddToProjectDialog';
import { DeleteNoteDialog } from './DeleteNoteDialog';
import { NoteLinkedModals } from './NoteLinkedModals';
import { SaveAllConfirmDialog, SyncProfileDialog } from './SyncProfileDialogs';
import type { Note } from '../types';

afterEach(cleanup);
const t = (key: string) => key;
const N: Note = { id: 'n1', name: 'Alpha', user_id: 'u1', user_name: 'Me', projects: ['p1'] };

describe('DeleteNoteDialog', () => {
  const base = { note: N, isSharedWithCurrentUser: false, deleting: false, error: null, t, onCancel: vi.fn(), onConfirm: vi.fn() };

  it('shows the delete wording with the note name, and Cancel and Delete call back', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<DeleteNoteDialog {...base} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByText('deleteNote?')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('uses the remove wording for a shared note and "Untitled note" without a name', () => {
    render(<DeleteNoteDialog {...base} note={{ ...N, name: '  ' }} isSharedWithCurrentUser />);
    expect(screen.getByText('Remove shared note?')).toBeInTheDocument();
    expect(screen.getByText('Untitled note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('the backdrop cancels unless a delete is running; inside clicks never cancel; errors are shown', () => {
    const onCancel = vi.fn();
    const { container, rerender } = render(<DeleteNoteDialog {...base} onCancel={onCancel} error="boom" />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByText('deleteNote?'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<DeleteNoteDialog {...base} onCancel={onCancel} deleting />);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'delete' })).toBeDisabled();
  });
});

describe('AddToProjectDialog', () => {
  const projects = [
    { id: 'p1', name: 'One', notes: ['n1'] },
    { id: 'p2', name: 'Two', notes: [] },
  ];
  const base = { note: N, projectOptions: projects, loading: false, savingId: null, error: null, t, onClose: vi.fn(), onSelect: vi.fn() };

  it('lists projects, disables the one that has the note, and selects another', () => {
    const onSelect = vi.fn();
    render(<AddToProjectDialog {...base} onSelect={onSelect} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect((screen.getByText('One').closest('button') as HTMLButtonElement)).toBeDisabled();
    fireEvent.click(screen.getByText('Two').closest('button') as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith(projects[1]);
  });

  it('shows loading, the empty state and an error', () => {
    const { rerender } = render(<AddToProjectDialog {...base} loading />);
    expect(screen.queryByText('One')).not.toBeInTheDocument();
    rerender(<AddToProjectDialog {...base} projectOptions={[]} error="bad" />);
    expect(screen.getByText('noProjectsFound')).toBeInTheDocument();
    expect(screen.getByText('bad')).toBeInTheDocument();
  });

  it('close and backdrop dismiss unless saving, when everything is disabled', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(<AddToProjectDialog {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<AddToProjectDialog {...base} onClose={onClose} savingId="p2" />);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'close' })).toBeDisabled();
    expect((screen.getByText('Two').closest('button') as HTMLButtonElement)).toBeDisabled();
  });
});

describe('SyncProfileDialog', () => {
  const profiles = [
    { speakerId: 's1', speakerName: 'Ann', draft: 'd1', isNew: false, saving: false, saved: false, saveError: null },
    { speakerId: null, speakerName: 'Bob', draft: 'd2', isNew: true, saving: false, saved: true, saveError: null },
  ];
  const handlers = () => ({ onClose: vi.fn(), onCopy: vi.fn(), onSave: vi.fn(), onDraftChange: vi.fn(), onSaveAll: vi.fn() });
  const base = { step: 'ready' as const, error: null, profiles, copiedKey: null, t };

  it('renders a card per speaker with badges, saved state and callbacks', () => {
    const hs = handlers();
    render(<SyncProfileDialog {...base} {...hs} />);
    expect(screen.getByText('updatedProfile')).toBeInTheDocument();
    expect(screen.getByText('newProfile')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 profiles saved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy profile for Ann' }));
    expect(hs.onCopy).toHaveBeenCalledWith('d1', 'history-profile-Ann');
    fireEvent.click(screen.getByRole('button', { name: /saveProfile/ }));
    expect(hs.onSave).toHaveBeenCalledWith('Ann');
    fireEvent.change(screen.getByDisplayValue('d1'), { target: { value: 'edited' } });
    expect(hs.onDraftChange).toHaveBeenCalledWith('Ann', 'edited');
    expect(screen.getByDisplayValue('d2')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'saveAll' }));
    expect(hs.onSaveAll).toHaveBeenCalled();
  });

  it('shows progress with close disabled, and ignores the backdrop while working', () => {
    const hs = handlers();
    const { container } = render(<SyncProfileDialog {...base} {...hs} step="generating" />);
    expect(screen.getByText('generatingProfilesAi')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'close' })).toBeDisabled();
    fireEvent.click(container.firstChild as HTMLElement);
    expect(hs.onClose).not.toHaveBeenCalled();
  });

  it('shows the error with a close button that works, and backdrop closes when idle', () => {
    const hs = handlers();
    const { container } = render(<SyncProfileDialog {...base} {...hs} step="error" error="nope" />);
    expect(screen.getByText('nope')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'close' }).pop() as HTMLElement);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(hs.onClose).toHaveBeenCalledTimes(2);
  });
});

describe('SaveAllConfirmDialog', () => {
  it('walks idle, saving, success and error states with the right buttons', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const props = { t, onClose, onConfirm, errorDetails: ['Ann: x'] };
    const { rerender, container } = render(<SaveAllConfirmDialog {...props} status="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'confirmSaveAll' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<SaveAllConfirmDialog {...props} status="saving" />);
    expect(screen.getByText('savingProfiles')).toBeInTheDocument();
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<SaveAllConfirmDialog {...props} status="success" />);
    expect(screen.getByText('profilesSaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    rerender(<SaveAllConfirmDialog {...props} status="error" />);
    expect(screen.getByText('failedSaveAllProfiles')).toBeInTheDocument();
    expect(screen.getByText('Ann: x')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('NoteLinkedModals', () => {
  const notes: Note[] = [N, { id: 'n2', name: 'Beta', user_id: 'other', user_name: 'Bea' }];
  const base = {
    notes,
    userId: 'u1',
    shareModalNoteId: null,
    knowledgeModalNoteId: null,
    getSharedUserIds: (n: Note) => (n.id === 'n1' ? ['a', 'b'] : []),
    onCloseShare: vi.fn(),
    onShared: vi.fn(),
    onCloseKnowledge: vi.fn(),
  };

  it('renders nothing when no modal is requested', () => {
    render(<NoteLinkedModals {...base} />);
    expect(screen.queryByTestId('share')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knowledge')).not.toBeInTheDocument();
  });

  it('opens share for the chosen note with its share list, and closes', () => {
    const onCloseShare = vi.fn();
    render(<NoteLinkedModals {...base} shareModalNoteId="n1" onCloseShare={onCloseShare} />);
    expect(screen.getByTestId('share')).toHaveTextContent('n1|Alpha|a,b');
    expect(screen.getByTestId('share')).toHaveAttribute('data-open', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'share-close' }));
    expect(onCloseShare).toHaveBeenCalled();
  });

  it('keeps share closed (isOpen false) when the note is no longer in the list', () => {
    render(<NoteLinkedModals {...base} shareModalNoteId="gone" />);
    expect(screen.getByTestId('share')).toHaveAttribute('data-open', 'false');
  });

  it('opens AX-KH only for the signed-in owner of the note', () => {
    const { rerender } = render(<NoteLinkedModals {...base} knowledgeModalNoteId="n1" />);
    expect(screen.getByTestId('knowledge')).toHaveTextContent('n1|Alpha');
    rerender(<NoteLinkedModals {...base} knowledgeModalNoteId="n2" />);
    expect(screen.queryByTestId('knowledge')).not.toBeInTheDocument();
  });
});
