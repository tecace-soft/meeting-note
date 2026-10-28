import MeetingKnowledgeModal from '../../../components/MeetingKnowledgeModal';
import ShareNoteModal from '../../../components/ShareNoteModal';
import { meetingKnowledgeUiEnabled } from '../../../services/meetingKnowledge';
import type { Note } from '../types';

export interface NoteLinkedModalsProps {
  notes: Note[];
  userId: string | undefined;
  shareModalNoteId: string | null;
  knowledgeModalNoteId: string | null;
  /** Current share list of a note as plain user ids. */
  getSharedUserIds: (note: Note) => string[];
  onCloseShare: () => void;
  onShared: (noteId: string, sharedUserIds: string[]) => void;
  onCloseKnowledge: () => void;
}

/**
 * Page-side wiring of the shared share and AX-KH (meeting knowledge) modals. The modals themselves are
 * shared with other pages and are not changed here; this only resolves which note each one is opened for.
 */
export function NoteLinkedModals({
  notes,
  userId,
  shareModalNoteId,
  knowledgeModalNoteId,
  getSharedUserIds,
  onCloseShare,
  onShared,
  onCloseKnowledge,
}: NoteLinkedModalsProps) {
  const knowledgeNote =
    meetingKnowledgeUiEnabled && knowledgeModalNoteId
      ? notes.find((n) => n.id === knowledgeModalNoteId && n.user_id === userId)
      : undefined;
  const shareNote = shareModalNoteId ? notes.find((n) => n.id === shareModalNoteId) : undefined;
  return (
    <>
      {knowledgeNote ? (
        <MeetingKnowledgeModal key={knowledgeNote.id} noteId={knowledgeNote.id} noteTitle={knowledgeNote.name} onClose={onCloseKnowledge} />
      ) : null}
      {shareModalNoteId ? (
        <ShareNoteModal
          isOpen={Boolean(shareNote)}
          noteId={shareNote?.id ?? null}
          noteTitle={shareNote?.name}
          existingSharedUserIds={shareNote ? getSharedUserIds(shareNote) : []}
          onClose={onCloseShare}
          onShared={onShared}
        />
      ) : null}
    </>
  );
}
