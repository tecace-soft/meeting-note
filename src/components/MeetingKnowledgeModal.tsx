import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CloseMd, Loading, Users } from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { fetchTecAceContacts, type MicrosoftContact } from '../services/microsoftContacts';
import {
  getMeetingKnowledgeStatus, isMicrosoftObjectId, MeetingKnowledgeApiError,
  mutateMeetingKnowledge, type MeetingKnowledgeAction, type MeetingKnowledgeStatus,
} from '../services/meetingKnowledge';

interface Props { noteId: string; noteTitle?: string | null; onClose: () => void }

/** Owner confirmation is explicit; directory labels never become identity or grants. */
const MeetingKnowledgeModal: React.FC<Props> = ({ noteId, noteTitle, onClose }) => {
  const { getAccessToken } = useAuth();
  const { appLanguage } = useLanguage();
  const ko = appLanguage === 'ko';
  const text = (korean: string, english: string) => ko ? korean : english;
  const [status, setStatus] = useState<MeetingKnowledgeStatus | null>(null);
  const [contacts, setContacts] = useState<MicrosoftContact[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsFailed, setContactsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    sessionRef.current = controller;
    pendingRef.current = false;
    setStatus(null); setContacts([]); setSelectedId(''); setSearch('');
    setLoading(true); setContactsLoading(true); setContactsFailed(false); setBusy(false); setErrorStatus(null);
    void getMeetingKnowledgeStatus(noteId, controller.signal).then(next => {
      if (!controller.signal.aborted) setStatus(next);
    }).catch(error => {
      if (!controller.signal.aborted) setErrorStatus(error instanceof MeetingKnowledgeApiError ? error.status : 503);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void (async () => {
      try {
        const token = await getAccessToken();
        if (controller.signal.aborted) return;
        if (!token) { setContactsFailed(true); return; }
        const next = await fetchTecAceContacts(token);
        if (!controller.signal.aborted) setContacts(next.flatMap(contact => {
          const id = contact.id.toLowerCase();
          return isMicrosoftObjectId(id) ? [{ ...contact, id }] : [];
        }));
      } catch { if (!controller.signal.aborted) setContactsFailed(true); }
      finally { if (!controller.signal.aborted) setContactsLoading(false); }
    })();
    return () => { controller.abort(); if (sessionRef.current === controller) sessionRef.current = null; };
  }, [noteId, getAccessToken]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  const filteredContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return contacts.filter(contact => `${contact.displayName} ${contact.email}`.toLowerCase().includes(query));
  }, [contacts, search]);
  const members = status ? [...new Set([...status.participants, ...status.directShares, ...status.projectShares, ...status.denies])] : [];
  const label = (id: string) => contacts.find(contact => contact.id === id)?.displayName ?? id;
  const mutate = async (action: MeetingKnowledgeAction, subjectObjectId?: string) => {
    const controller = sessionRef.current;
    if (!controller || controller.signal.aborted || pendingRef.current || (!status && action !== 'initialize')) return;
    pendingRef.current = true; setBusy(true); setErrorStatus(null);
    try {
      await mutateMeetingKnowledge({ action, sourceId: noteId,
        ...(action !== 'initialize' ? { expectedAccessRevision: status!.accessRevision! } : {}),
        ...(subjectObjectId ? { subjectObjectId } : {}),
        ...(action === 'confirm_participant' ? { verificationRef: `owner-confirmed:${crypto.randomUUID()}` } : {}),
      }, controller.signal);
      const next = await getMeetingKnowledgeStatus(noteId, controller.signal);
      if (!controller.signal.aborted) { setStatus(next); setSelectedId(''); }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof MeetingKnowledgeApiError ? error.status : 503;
        setErrorStatus(code);
        // Refresh the owner snapshot after a conflict; never replay a mutation.
        if (code === 409) {
          try { const next = await getMeetingKnowledgeStatus(noteId, controller.signal); if (!controller.signal.aborted) setStatus(next); }
          catch { if (!controller.signal.aborted) setStatus(null); }
        }
      }
    } finally { if (!controller.signal.aborted) { pendingRef.current = false; setBusy(false); } }
  };
  const buttonClass = 'summary-toolbar-btn rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
  const errorText = errorStatus === 409 ? text('권한 정보가 변경되었습니다. 새 정보를 확인한 뒤 다시 선택해 주세요.', 'Access changed. Review the refreshed information before choosing again.')
    : errorStatus === 401 ? text('검증된 Microsoft 로그인이 필요합니다. 다시 로그인해 주세요.', 'A verified Microsoft sign-in is required. Please sign in again.')
      : errorStatus === 403 ? text('회의록 소유자만 이 설정을 관리할 수 있습니다.', 'Only the note owner can manage these settings.')
        : text('연동 정보를 확인하거나 저장할 수 없습니다. 잠시 후 창을 다시 열어 주세요.', 'Could not load or save integration settings. Please reopen this window later.');

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }} onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="meeting-knowledge-title" aria-describedby="meeting-knowledge-description"
        className="w-full max-w-2xl rounded-xl border p-4 sm:p-5 max-h-[90vh] overflow-y-auto custom-scrollbar"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }} onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div><h2 id="meeting-knowledge-title" className="text-lg font-semibold">{text('AXKH 연동 · 참석 확인', 'AXKH integration · attendance')}</h2>
            {noteTitle ? <p className="mt-1 text-sm break-words" style={{ color: 'var(--text-secondary)' }}>{noteTitle}</p> : null}</div>
          <button ref={closeRef} type="button" onClick={onClose} className={buttonClass} aria-label={text('창 닫기', 'Close dialog')}><CloseMd className="h-4 w-4" aria-hidden /></button>
        </div>
        <p id="meeting-knowledge-description" className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {text('소유자가 확인한 참석자와 회의록을 공유받은 사람만, AXKH의 보안 권한도 충족할 때 내용을 참조할 수 있습니다. 화자 이름만으로 접근 권한을 부여하지 않습니다.', 'Only owner-confirmed participants and people with note access may reference this content, subject to AXKH security permissions. Speaker names do not grant access.')}
        </p>
        {loading ? <p className="flex items-center gap-2 py-6" role="status"><Loading className="h-4 w-4 animate-spin" aria-hidden />{text('연동 정보 확인 중…', 'Loading integration settings…')}</p> : null}
        {status ? <>
          {status.unsupportedTranscript ? <p className="mt-4 text-sm" style={{ color: 'var(--error)' }}>{text('원문 형식을 확인할 수 없어 연동을 시작할 수 없습니다. 기존 회의록은 계속 사용할 수 있습니다.', 'This transcript format cannot be verified for integration. You can continue using the note.')}</p> : null}
          {!status.enrolled ? <div className="mt-4"><p className="mb-3 text-sm">{text('아직 연동 설정이 없습니다. 설정을 만들면 참석 확인을 시작할 수 있으며, 전송은 별도로 켜야 합니다.', 'Integration is not configured. Create settings to confirm attendance, then enable delivery separately.')}</p>
            <button type="button" className={buttonClass} disabled={busy || status.unsupportedTranscript} onClick={() => void mutate('initialize')}>{text('연동 설정 만들기', 'Create integration settings')}</button></div> : <>
            <div className="mt-4 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border)' }}>
              <div className="flex flex-wrap items-center justify-between gap-3"><span>{status.integrationEnabled ? text('전송 켜짐', 'Delivery enabled') : text('전송 꺼짐', 'Delivery disabled')}</span>
                <button type="button" className={buttonClass} disabled={busy || (status.unsupportedTranscript && !status.integrationEnabled)} onClick={() => void mutate(status.integrationEnabled ? 'disable' : 'enable')}>{status.integrationEnabled ? text('전송 끄기', 'Disable delivery') : text('전송 켜기', 'Enable delivery')}</button></div>
              <p className="mt-2" style={{ color: 'var(--text-secondary)' }}>{text('전송 후에도 AXKH의 분류·검증이 필요합니다. 이 화면은 검색 가능 여부를 보장하지 않습니다.', 'AXKH classification and validation are required after delivery. This screen does not confirm search availability.')}</p>
              <p className="mt-2" role="status">{status.delivery.lastErrorCode ? text('전송을 완료하지 못했습니다. 재시도 대기 중입니다.', 'Delivery did not complete. Waiting for retry.') : status.delivery.pending > 0 ? text(`전송 대기 ${status.delivery.pending}건`, `${status.delivery.pending} deliveries pending`) : status.delivery.lastDeliveredAt ? text('최근 전송 완료', 'Latest delivery completed') : text('전송 기록 없음', 'No delivery recorded')}</p>
            </div>
            <h3 className="mt-5 text-sm font-semibold">{text('실제 참석자 확인', 'Confirm actual attendance')}</h3>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{text('참석 사실을 확인한 Microsoft 디렉터리 연락처를 선택하세요. 공유 설정은 기존 공유 메뉴에서 관리합니다.', 'Select a Microsoft directory contact whose attendance you have confirmed. Manage sharing in the existing Share menu.')}</p>
            {contactsLoading ? <p className="mt-2 text-sm" role="status">{text('연락처 불러오는 중…', 'Loading contacts…')}</p> : contactsFailed ? <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>{text('디렉터리 연락처를 불러올 수 없습니다. 참석 확인은 창을 다시 연 후 시도해 주세요.', 'Directory contacts could not be loaded. Reopen this window to confirm attendance.')}</p> : null}
            <label className="mt-3 block text-sm" htmlFor="meeting-knowledge-contact-search">{text('연락처 검색', 'Search contacts')}</label>
            <input id="meeting-knowledge-contact-search" type="search" value={search} onChange={event => setSearch(event.target.value)} disabled={busy || contactsLoading}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }} />
            <label className="mt-3 block text-sm" htmlFor="meeting-knowledge-contact">{text('참석자', 'Participant')}</label>
            <select id="meeting-knowledge-contact" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={busy || contactsLoading || contactsFailed}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}>
              <option value="">{text('연락처 선택', 'Select a contact')}</option>
              {filteredContacts.map(contact => <option key={contact.id} value={contact.id}>{contact.displayName} ({contact.email})</option>)}
            </select>
            <button type="button" className={`${buttonClass} mt-3`} disabled={busy || !selectedId || !contacts.some(contact => contact.id === selectedId) || status.participants.includes(selectedId) || status.denies.includes(selectedId)}
              onClick={() => void mutate('confirm_participant', selectedId)}>{text('선택한 사람의 참석 확인', 'Confirm selected contact attended')}</button>
            <h3 className="mt-5 text-sm font-semibold flex items-center gap-2"><Users className="h-4 w-4" aria-hidden />{text('참석·공유·철회 상태', 'Attendance, sharing and revocation')}</h3>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{text('철회는 참석·공유 권한보다 우선합니다. 철회 해제는 참석이나 공유를 새로 추가하지 않습니다.', 'Revocation overrides attendance and sharing. Clearing a revocation does not add attendance or sharing.')}</p>
            <ul className="mt-3 divide-y" style={{ borderColor: 'var(--border)' }}>
              {members.map(id => <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-medium break-all">{label(id)}</p>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>{[
                  status.participants.includes(id) ? text('참석 확인됨', 'Attendance confirmed') : '',
                  status.directShares.includes(id) ? text('직접 공유됨', 'Directly shared') : '',
                  status.projectShares.includes(id) ? text('프로젝트 공유됨', 'Project shared') : '',
                  status.denies.includes(id) ? text('접근 철회됨', 'Access revoked') : '',
                ].filter(Boolean).join(' · ')}</p></div>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void mutate(status.denies.includes(id) ? 'restore' : 'revoke', id)}>{status.denies.includes(id) ? text('철회 해제', 'Clear revocation') : text('접근 철회', 'Revoke access')}</button></li>)}
            </ul>
            {members.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{text('확인된 참석자나 공유 대상이 없습니다.', 'No confirmed participants or sharing recipients.')}</p> : null}
          </>}
        </> : null}
        {errorStatus ? <p className="mt-4 text-sm" role="alert" style={{ color: 'var(--error)' }}>{errorText}</p> : null}
        {busy ? <p className="mt-3 text-sm flex items-center gap-2" role="status"><Loading className="h-4 w-4 animate-spin" aria-hidden />{text('저장 중…', 'Saving…')}</p> : null}
        <div className="mt-4 flex justify-end"><button type="button" onClick={onClose} className={buttonClass}>{text('닫기', 'Close')}</button></div>
      </div>
    </div>
  );
};
export default MeetingKnowledgeModal;
