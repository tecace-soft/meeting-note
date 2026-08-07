import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { clearUserMemory, fetchUserMemory, type MemoryItem } from '../lib/userMemory';

// F1' minimal read-only surface for the per-user "personal memory" base. It shows
// the memory as a single list of natural-language items (most-recently-updated
// first) and lets the user delete it. The base is populated automatically in the
// background after each meeting summary. A polished dashboard is later design work.

interface Props {
  userId: string;
}

type LoadStatus = 'loading' | 'loaded' | 'error';

export function UserMemoryView({ userId }: Props): JSX.Element {
  const { appLanguage } = useLanguage();
  const ko = appLanguage === 'ko';
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await fetchUserMemory(userId);
      setItems(result?.items ?? null);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await clearUserMemory(userId);
      setItems(null);
      setConfirmingDelete(false);
    } catch {
      setStatus('error');
    } finally {
      setDeleting(false);
    }
  }, [userId]);

  const isEmpty = !items || items.length === 0;

  return (
    <div>
      <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
        {ko ? '내 메모리' : 'My memory'}
      </h3>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {ko
          ? '회의 요약이 생성될 때마다 자동으로 쌓이는 개인 컨텍스트입니다. 읽기 전용이며, 언제든 삭제할 수 있습니다.'
          : 'Personal context that builds automatically after each meeting summary. Read-only, and you can delete it anytime.'}
      </p>

      {status === 'loading' ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          {ko ? '불러오는 중…' : 'Loading…'}
        </p>
      ) : status === 'error' ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--danger, #dc2626)' }}>
          {ko ? '메모리를 불러오지 못했습니다.' : 'Could not load your memory.'}
        </p>
      ) : isEmpty ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          {ko
            ? '아직 메모리가 없습니다. 회의를 요약하면 자동으로 채워집니다.'
            : 'No memory yet. It fills in automatically once you summarize a meeting.'}
        </p>
      ) : (
        <ul className="mt-5 space-y-2.5 pl-4" style={{ listStyleType: 'disc' }}>
          {items!.map((item) => (
            <li key={item.id} className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
              {item.text}
              {item.entities.length > 0 ? (
                <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {item.entities.join(' · ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {status === 'loaded' && !isEmpty ? (
        <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {ko ? '메모리를 모두 삭제할까요? 되돌릴 수 없습니다.' : 'Delete all your memory? This cannot be undone.'}
              </span>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: 'var(--danger, #dc2626)', color: '#fff', opacity: deleting ? 0.6 : 1 }}
              >
                {deleting ? (ko ? '삭제 중…' : 'Deleting…') : ko ? '삭제' : 'Delete'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-md px-3 py-1.5 text-sm font-medium"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text)' }}
              >
                {ko ? '취소' : 'Cancel'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-md px-3 py-1.5 text-sm font-medium"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--danger, #dc2626)' }}
            >
              {ko ? '내 메모리 삭제' : 'Delete my memory'}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
