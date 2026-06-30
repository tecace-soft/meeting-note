import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CloseMd, Loading, SearchMagnifyingGlass, ShareAndroid, Users } from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { supabase } from '../config/supabaseConfig';
import { fetchTecAceContacts, type MicrosoftContact } from '../services/microsoftContacts';

interface ShareProjectModalProps {
  isOpen: boolean;
  projectId: string | null;
  projectTitle?: string | null;
  existingSharedUserIds?: string[] | null;
  onClose: () => void;
  onShared?: (projectId: string, sharedUserIds: string[]) => void;
}

function normalizeSharedUserIds(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

const ShareProjectModal: React.FC<ShareProjectModalProps> = ({
  isOpen,
  projectId,
  projectTitle,
  existingSharedUserIds,
  onClose,
  onShared,
}) => {
  const { user, getAccessToken } = useAuth();
  const { t, appLanguage } = useLanguage();
  const [contacts, setContacts] = useState<MicrosoftContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedIds(normalizeSharedUserIds(existingSharedUserIds));
    setSearch('');
    setError(null);
  }, [existingSharedUserIds, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const loadContacts = async () => {
      setLoadingContacts(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Unable to access Microsoft contacts. Please sign in again.');
        const nextContacts = await fetchTecAceContacts(token);
        if (!cancelled) setContacts(nextContacts);
      } catch (err) {
        if (!cancelled) {
          setContacts([]);
          setError(err instanceof Error ? err.message : 'Could not load TecAce contacts.');
        }
      } finally {
        if (!cancelled) setLoadingContacts(false);
      }
    };
    void loadContacts();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, isOpen]);

  const filteredContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter((contact) => {
      const haystack = `${contact.displayName} ${contact.email} ${contact.userPrincipalName}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [contacts, search]);

  const toggleContact = useCallback((contactId: string) => {
    setSelectedIds((prev) =>
      prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [...prev, contactId]
    );
  }, []);

  const handleSave = async () => {
    if (!projectId || !user?.id) return;
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await supabase
        .from('project')
        .update({ shared_users: selectedIds })
        .eq('id', projectId)
        .eq('user_id', user.id);
      if (updateError) throw updateError;
      onShared?.(projectId, selectedIds);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not share this project.');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      role="presentation"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="share-note-modal w-full max-w-2xl rounded-xl border p-4 sm:p-5"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--surface)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-project-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShareAndroid className="h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden />
              <h2 id="share-project-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                {appLanguage === 'ko' ? '프로젝트 공유' : 'Share project'}
              </h2>
            </div>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {projectTitle?.trim()
                ? `Select TecAce contacts who should have access to "${projectTitle.trim()}" and its notes.`
                : 'Select TecAce contacts who should have access to this project and its notes.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="summary-toolbar-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-50"
            aria-label={appLanguage === 'ko' ? '프로젝트 공유 창 닫기' : 'Close share project'}
          >
            <CloseMd className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="relative mb-3">
          <SearchMagnifyingGlass
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }}
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={appLanguage === 'ko' ? 'TecAce 연락처 검색' : 'Search TecAce contacts'}
            className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm"
            style={{
              backgroundColor: 'var(--surface)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
        </div>

        <div className="share-note-contact-list summary-note-list custom-scrollbar">
          {loadingContacts ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <Loading className="h-4 w-4 animate-spin" aria-hidden />
              Loading TecAce contacts...
            </div>
          ) : filteredContacts.length > 0 ? (
            filteredContacts.map((contact) => {
              const selected = selectedIds.includes(contact.id);
              return (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => toggleContact(contact.id)}
                  className={`summary-note-row share-note-contact-row w-full text-left ${
                    selected ? 'summary-note-row-active' : ''
                  }`}
                >
                  <span className="summary-note-row-rail" aria-hidden />
                  <span className="summary-note-row-content flex min-h-[4rem] items-center gap-3 px-3 py-3">
                    <span
                      className={`project-note-picker-checkbox ${selected ? 'project-note-picker-checkbox-checked' : ''}`}
                      aria-hidden
                    >
                      {selected ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
                        {contact.displayName}
                      </span>
                      <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                        {contact.email}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <Users className="h-5 w-5" style={{ color: 'var(--text-muted)' }} aria-hidden />
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {contacts.length === 0 ? 'No TecAce contacts found.' : 'No contacts match your search.'}
              </p>
            </div>
          )}
        </div>

        {error ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="summary-toolbar-btn rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !projectId}
            className="btn-accent inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : <ShareAndroid className="h-4 w-4" aria-hidden />}
            {appLanguage === 'ko' ? '공유' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareProjectModal;
