// F2: in-app feedback / issue tracker — 3-pane board (register · list · triage).
// One triage panel is rendered and reflows across breakpoints, so the edit draft lives at
// this board level and never duplicates (avoids the "input lost on resize" bug, spec §1/§6).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLanguage, type TranslationKey } from '../context/LanguageContext';
import {
  AREA_OPTIONS, PURPOSE_OPTIONS, STATUS_OPTIONS, PRIORITY_OPTIONS, SEVERITY_OPTIONS,
  statusColor, priorityColor,
  listIssues, createIssue, updateIssue, softDeleteIssue,
  uploadIssueAttachment, deleteIssueAttachment, signAttachmentUrls,
  generateIssueResolution, notifyIssue, suggestTriage,
  type FeedbackIssue, type IssueAttachment, type IssuePurpose, type IssueStatus,
  type IssuePriority, type IssueSeverity, type TriageSuggestion,
} from '../lib/feedbackIssues';

const CARD = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 } as const;

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)`, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

export default function Issues() {
  const { user, getAccessToken } = useAuth();
  const { t } = useLanguage();
  const myEmail = (user?.email ?? '').toLowerCase();

  const [issues, setIssues] = useState<FeedbackIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const rows = await listIssues();
      setIssues(rows);
      const map = await signAttachmentUrls(rows.flatMap((r) => r.attachments));
      setUrls((prev) => ({ ...prev, ...map }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const selected = issues.find((i) => i.id === selectedId) ?? null;
  const kpi = useMemo(() => ({
    open: issues.filter((i) => i.status !== 'DONE' && i.status !== 'CLOSED').length,
    triage: issues.filter((i) => !i.triagedAt).length,
    mine: issues.filter((i) => (i.assigneeEmail ?? '').toLowerCase() === myEmail).length,
  }), [issues, myEmail]);

  return (
    <div style={{ padding: '20px clamp(14px,3vw,28px)', color: 'var(--text)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 14px' }}>{t('issuesTitle')}</h1>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi label={t('issuesKpiOpen')} value={kpi.open} />
        <Kpi label={t('issuesKpiTriage')} value={kpi.triage} accent="var(--error)" />
        <Kpi label={t('issuesKpiMine')} value={kpi.mine} />
      </div>

      {error ? (
        <div style={{ ...CARD, borderColor: 'var(--error)', padding: 12, marginBottom: 14, color: 'var(--error)', fontSize: 13 }}>{error}</div>
      ) : null}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(260px,1fr) minmax(280px,1.1fr) minmax(300px,1.2fr)' }} className="issues-grid">
        <RegisterPane user={user} getAccessToken={getAccessToken} onCreated={reload} setUrls={setUrls} t={t} />
        <ListPane issues={issues} loading={loading} selectedId={selectedId} onSelect={setSelectedId} t={t} />
        <TriagePane
          key={selected?.id ?? 'none'}
          issue={selected}
          urls={urls}
          myEmail={myEmail}
          getAccessToken={getAccessToken}
          onChanged={reload}
          onDeleted={() => { setSelectedId(null); void reload(); }}
          t={t}
        />
      </div>
      <style>{`@media (max-width: 900px){ .issues-grid{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{ ...CARD, padding: '10px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

// ── Register pane ───────────────────────────────────────────────────────────

function RegisterPane({ user, getAccessToken, onCreated, setUrls, t }: {
  user: ReturnType<typeof useAuth>['user'];
  getAccessToken: () => Promise<string | null>;
  onCreated: () => Promise<void> | void;
  setUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  t: (k: TranslationKey) => string;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [override, setOverride] = useState<{ purpose?: IssuePurpose; area?: string; priority?: IssuePriority; severity?: IssueSeverity }>({});
  const [attachments, setAttachments] = useState<IssueAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const suggestion: TriageSuggestion = useMemo(() => suggestTriage(title, description), [title, description]);
  const val = {
    purpose: override.purpose ?? suggestion.purpose,
    area: override.area ?? suggestion.area,
    priority: override.priority ?? suggestion.priority,
    severity: override.severity ?? suggestion.severity,
  };

  const doUpload = useCallback(async (files: File[]) => {
    if (!user?.id) return;
    for (const [idx, file] of files.entries()) {
      if (!file.type.startsWith('image/') && file.type !== 'application/pdf') continue;
      try {
        const name = file.name && file.name !== 'image.png' ? file.name : `스크린샷-${Date.now() % 1000}-${idx + 1}.png`;
        const att = await uploadIssueAttachment(file, user.id, name);
        const signed = await signAttachmentUrls([att]);
        setUrls((prev) => ({ ...prev, ...signed }));
        setAttachments((prev) => [...prev, att]);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      }
    }
  }, [user?.id, setUrls]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) { e.preventDefault(); void doUpload(files); }
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); void doUpload(Array.from(e.dataTransfer.files)); };

  const removeAttachment = async (att: IssueAttachment) => {
    setAttachments((prev) => prev.filter((a) => a.path !== att.path));
    await deleteIssueAttachment(att.path).catch(() => undefined);
  };

  const submit = async () => {
    if (!title.trim() || !description.trim() || !user) { setMsg('제목과 설명을 입력하세요.'); return; }
    try {
      setSubmitting(true); setMsg(null);
      const created = await createIssue({
        title, description, purpose: val.purpose, area: val.area, priority: val.priority, severity: val.severity,
        attachments, aiSuggestion: suggestion,
        authorEmail: user.email ?? '', authorName: user.displayName ?? null,
      });
      void notifyIssue('created', created, getAccessToken);
      setTitle(''); setDescription(''); setOverride({}); setAttachments([]);
      await onCreated();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ ...CARD, padding: 16 }} onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} tabIndex={0}>
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>{t('issuesNew')}</h2>
      <Field label={t('issuesFieldTitle')}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
      </Field>
      <Field label={t('issuesFieldDesc')}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
        <Select value={val.purpose} onChange={(v) => setOverride((o) => ({ ...o, purpose: v as IssuePurpose }))}
          options={PURPOSE_OPTIONS.map((p) => ({ value: p.value, label: p.labelKo }))} />
        <Select value={val.area} onChange={(v) => setOverride((o) => ({ ...o, area: v }))}
          options={AREA_OPTIONS.map((a) => ({ value: a.value, label: a.labelKo }))} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Select value={val.priority} onChange={(v) => setOverride((o) => ({ ...o, priority: v as IssuePriority }))}
          options={PRIORITY_OPTIONS.map((p) => ({ value: p.value, label: p.value }))} />
        <Select value={val.severity} onChange={(v) => setOverride((o) => ({ ...o, severity: v as IssueSeverity }))}
          options={SEVERITY_OPTIONS.map((p) => ({ value: p.value, label: p.value }))} />
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>💡 {suggestion.reason}</p>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button type="button" onClick={() => fileRef.current?.click()} style={ghostBtn}>{t('issuesAttach')}</button>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple style={{ display: 'none' }}
          onChange={(e) => { void doUpload(Array.from(e.target.files ?? [])); e.currentTarget.value = ''; }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ctrl+V / 드래그</span>
      </div>
      <AttachmentGrid attachments={attachments} urls={{}} onRemove={removeAttachment} />

      {msg ? <p style={{ color: 'var(--error)', fontSize: 12, margin: '6px 0 0' }}>{msg}</p> : null}
      <button type="button" disabled={submitting} onClick={() => void submit()} style={{ ...primaryBtn, marginTop: 12, width: '100%' }}>
        {submitting ? '...' : t('issuesSubmit')}
      </button>
    </div>
  );
}

// ── List pane ───────────────────────────────────────────────────────────────

function ListPane({ issues, loading, selectedId, onSelect, t }: {
  issues: FeedbackIssue[]; loading: boolean; selectedId: string | null; onSelect: (id: string) => void; t: (k: TranslationKey) => string;
}) {
  const [status, setStatus] = useState<string>('');
  const [assignee, setAssignee] = useState<string>('');
  const assignees = useMemo(() => Array.from(new Set(issues.map((i) => i.assigneeName).filter(Boolean))) as string[], [issues]);
  const filtered = issues.filter((i) => (!status || i.status === status) && (!assignee || i.assigneeName === assignee));
  const groups = PURPOSE_OPTIONS.map((p) => ({ p, items: filtered.filter((i) => i.purpose === p.value) }));

  return (
    <div style={{ ...CARD, padding: 12, display: 'flex', flexDirection: 'column', minHeight: 200 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Select value={assignee} onChange={setAssignee} options={[{ value: '', label: t('issuesAllAssignees') }, ...assignees.map((a) => ({ value: a, label: a }))]} />
        <Select value={status} onChange={setStatus} options={[{ value: '', label: t('issuesAllStatus') }, ...STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.labelKo }))]} />
      </div>
      {loading ? <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>...</p> : null}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map(({ p, items }) => (
          <div key={p.value}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', margin: '2px 0 6px' }}>
              <span style={{ color: p.color }}>▸</span> {p.labelKo} ({items.length})
            </div>
            {items.map((i) => (
              <button key={i.id} type="button" onClick={() => onSelect(i.id)}
                style={{ textAlign: 'left', width: '100%', padding: '8px 10px', marginBottom: 6, borderRadius: 10, cursor: 'pointer',
                  background: selectedId === i.id ? 'var(--accent-light)' : 'var(--surface-subtle)',
                  border: `1px solid ${selectedId === i.id ? 'var(--accent)' : 'var(--border)'}` }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3, flexWrap: 'wrap' }}>
                  <Badge label={i.status} color={statusColor(i.status)} />
                  <Badge label={i.priority} color={priorityColor(i.priority)} />
                  {!i.triagedAt ? <Badge label="Triage 필요" color="#f59e0b" /> : null}
                  {i.attachments.length ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>📎 {i.attachments.length}</span> : null}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{i.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{i.issueKey} · {i.authorName ?? i.authorEmail}{i.assigneeName ? ` → ${i.assigneeName}` : ''}</div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Triage pane ─────────────────────────────────────────────────────────────

function TriagePane({ issue, urls, myEmail, getAccessToken, onChanged, onDeleted, t }: {
  issue: FeedbackIssue | null; urls: Record<string, string>; myEmail: string;
  getAccessToken: () => Promise<string | null>; onChanged: () => Promise<void> | void; onDeleted: () => void; t: (k: TranslationKey) => string;
}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<IssueStatus>('OPEN');
  const [priority, setPriority] = useState<IssuePriority>('P3');
  const [severity, setSeverity] = useState<IssueSeverity>('Medium');
  const [assigneeName, setAssigneeName] = useState('');
  const [assigneeEmail, setAssigneeEmail] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!issue) return;
    setStatus(issue.status); setPriority(issue.priority); setSeverity(issue.severity);
    setAssigneeName(issue.assigneeName ?? ''); setAssigneeEmail(issue.assigneeEmail ?? '');
    setNote(issue.triageNote ?? ''); setMsg(null);
  }, [issue]);

  if (!issue) return <div style={{ ...CARD, padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>{t('issuesSelectHint')}</div>;

  const save = async () => {
    try {
      setSaving(true); setMsg(null);
      const prevAssignee = (issue.assigneeEmail ?? '').toLowerCase();
      const updated = await updateIssue(issue.id, {
        status, priority, severity,
        assigneeEmail: assigneeEmail.trim() || null, assigneeName: assigneeName.trim() || null,
        triageNote: note.trim() || null, triagedBy: user?.displayName ?? user?.email ?? 'unknown',
      });
      const newAssignee = (assigneeEmail.trim() || '').toLowerCase();
      if (newAssignee && newAssignee !== prevAssignee && newAssignee !== myEmail) {
        void notifyIssue('assigned', updated, getAccessToken);
      }
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const genResolution = async () => {
    try {
      setResolving(true); setMsg(null);
      const { resolution, model } = await generateIssueResolution(issue, getAccessToken);
      await updateIssue(issue.id, { resolution, resolutionModel: model });
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  const del = async () => {
    if (!user?.email) return;
    try {
      await softDeleteIssue(issue, user.email);
      onDeleted();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const isAuthor = (issue.authorEmail ?? '').toLowerCase() === myEmail;
  return (
    <div style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '80vh', overflowY: 'auto' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.issueKey} · {issue.authorName ?? issue.authorEmail}</div>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{issue.title}</div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{issue.description}</div>
      <AttachmentGrid attachments={issue.attachments} urls={urls} />

      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Select value={status} onChange={(v) => setStatus(v as IssueStatus)} options={STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.labelKo }))} />
        <Select value={priority} onChange={(v) => setPriority(v as IssuePriority)} options={PRIORITY_OPTIONS.map((p) => ({ value: p.value, label: p.value }))} />
        <Select value={severity} onChange={(v) => setSeverity(v as IssueSeverity)} options={SEVERITY_OPTIONS.map((p) => ({ value: p.value, label: p.value }))} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input placeholder={t('issuesAssigneeName')} value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} style={inputStyle} />
        <input placeholder="email" value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)} style={inputStyle} />
      </div>
      <button type="button" onClick={() => { setAssigneeName(user?.displayName ?? ''); setAssigneeEmail(user?.email ?? ''); }} style={{ ...ghostBtn, alignSelf: 'flex-start' }}>{t('issuesAssignMe')}</button>
      <textarea placeholder={t('issuesTriageNote')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />

      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <button type="button" disabled={resolving} onClick={() => void genResolution()} style={{ ...ghostBtn, width: '100%' }}>
        {resolving ? '분석 중...' : (issue.resolution ? t('issuesRegenResolution') : t('issuesGenResolution'))}
      </button>
      {issue.resolution ? (
        <div style={{ fontSize: 12.5, marginTop: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{issue.resolution.summary} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({issue.resolution.confidence})</span></div>
          <ResList label={t('issuesRootCauses')} items={issue.resolution.rootCauses} />
          <ResList label={t('issuesChecks')} items={issue.resolution.checks} />
          <ResList label={t('issuesFixPlan')} items={issue.resolution.fixPlan} />
          <ResList label={t('issuesVerification')} items={issue.resolution.verification} />
        </div>
      ) : null}

      {msg ? <p style={{ color: 'var(--error)', fontSize: 12 }}>{msg}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" disabled={saving} onClick={() => void save()} style={{ ...primaryBtn, flex: 1 }}>{saving ? '...' : t('issuesSave')}</button>
        {isAuthor ? <button type="button" onClick={() => void del()} style={{ ...ghostBtn, color: 'var(--error)' }}>{t('issuesDelete')}</button> : null}
      </div>
    </div>
  );
}

function ResList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{items.map((i, idx) => <li key={idx}>{i}</li>)}</ul>
    </div>
  );
}

function AttachmentGrid({ attachments, urls, onRemove }: { attachments: IssueAttachment[]; urls: Record<string, string>; onRemove?: (a: IssueAttachment) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
      {attachments.map((a) => {
        const url = urls[a.path];
        return (
          <div key={a.path} style={{ position: 'relative' }}>
            {url && a.type.startsWith('image/')
              ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.name} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} /></a>
              : <div style={{ width: 72, height: 72, borderRadius: 8, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: 4 }}>{a.name}</div>}
            {onRemove ? <button type="button" onClick={() => void onRemove(a)} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11, lineHeight: '18px' }}>×</button> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-subtle)', color: 'var(--text)', fontSize: 13, outline: 'none' };
const primaryBtn: React.CSSProperties = { padding: '9px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
