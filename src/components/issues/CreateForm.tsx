// F2: new-issue form (CREATE-*, ATT-*) and its completion view (CREATE-10).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bulb, Chat, CircleCheck, CircleHelp, CircleWarning } from 'react-coolicons';
import type { AppLanguage } from '../../context/LanguageContext';
import { AREA_OPTIONS, PURPOSE_ORDER, purposeLabel } from '../../lib/issues/constants';
import { displayName } from '../../lib/issues/keys';
import { describeRecipients } from '../../lib/issues/mailDecision';
import {
  AttachmentTooLargeError, createIssue, deleteAttachment, signAttachmentUrls, uploadAttachment,
} from '../../lib/issues/service';
import { notifyCreated } from '../../lib/issues/serverApi';
import { operationError, type IssueStrings } from '../../lib/issues/strings';
import { suggestTriage } from '../../lib/issues/triageRules';
import type { DirectoryUser, Issue, IssueAttachment, PurposeId } from '../../lib/issues/types';
import { useDocumentPaste, useIssueFormState, useMediaQuery } from './hooks';
import { AttachmentThumbs } from './parts';

const PURPOSE_ICON: Record<PurposeId, typeof Bulb> = { bug: CircleWarning, feature: Bulb, question: CircleHelp, other: Chat };

export function CreateForm({
  s, lang, draftKey, author, getAccessToken, onCreated, active,
}: {
  /** False while the form is hidden behind the narrow-screen pane switch (no paste capture). */
  active: boolean;
  s: IssueStrings;
  lang: AppLanguage;
  draftKey: string;
  author: { email: string; name: string | null };
  getAccessToken: () => Promise<string | null>;
  /** notifiedEmails = null when the notify request failed (CREATE-11, no false "sent"). */
  onCreated: (issue: Issue, notifiedEmails: string[] | null) => void;
}) {
  const { form, update, restored, reset } = useIssueFormState(draftKey);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<IssueAttachment[]>(form.attachments);
  attachmentsRef.current = form.attachments;
  const wide = useMediaQuery('(min-width: 640px)');

  // CREATE-5: computed on render from the current input, never synced through an effect.
  const suggestion = useMemo(
    () => suggestTriage(form.title, form.description, form.purposeOverride),
    [form.title, form.description, form.purposeOverride],
  );
  const hasText = !!(form.title.trim() || form.description.trim());
  const shownPurpose: PurposeId | null = form.purposeOverride ?? (hasText ? suggestion.purpose : null);
  const shownArea = form.areaOverride ?? suggestion.area;

  // Restored attachments need fresh signed URLs for their thumbnails.
  const restoredPaths = useRef(form.attachments.map((a) => a.path));
  useEffect(() => {
    if (restoredPaths.current.length === 0) return;
    void signAttachmentUrls(restoredPaths.current).then((map) => setUrls((prev) => ({ ...prev, ...map })));
  }, []);

  const uploadFiles = async (files: File[]) => {
    setFormError(null);
    const errors: string[] = [];
    const base = attachmentsRef.current.length;
    for (const [i, file] of files.entries()) {
      const name = displayName(file, base + i);
      setUploading((n) => n + 1);
      try {
        const att = await uploadAttachment(file, name);
        attachmentsRef.current = [...attachmentsRef.current, att];
        update({ attachments: attachmentsRef.current });
        const signed = await signAttachmentUrls([att.path]);
        setUrls((prev) => ({ ...prev, ...signed }));
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) errors.push(s.attachTooLarge(name));
        else {
          const raw = error instanceof Error ? error.message : String(error);
          errors.push(/bucket not found/i.test(raw) ? s.attachBucketMissing : s.attachFailed(name, raw));
        }
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (errors.length) setFormError(errors.join(' '));
  };

  useDocumentPaste((files) => void uploadFiles(files), active);

  const removeAttachment = (a: IssueAttachment) => {
    attachmentsRef.current = attachmentsRef.current.filter((x) => x.path !== a.path);
    update({ attachments: attachmentsRef.current });
    void deleteAttachment(a.path);
  };

  const startOver = () => {
    for (const a of attachmentsRef.current) void deleteAttachment(a.path);
    attachmentsRef.current = [];
    setFormError(null);
    reset();
  };

  const submit = async () => {
    if (submitting) return;
    const title = form.title.trim();
    const description = form.description.trim();
    if (!title || !description) {
      setFormError(s.errEmpty);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const final = suggestTriage(title, description, form.purposeOverride); // CREATE-9: same call, whole result
      const issue = await createIssue({
        title,
        description,
        purpose: form.purposeOverride ?? final.purpose,
        area: form.areaOverride ?? final.area,
        priority: final.priority,
        aiSuggestion: final,
        attachments: attachmentsRef.current,
        authorEmail: author.email,
        authorName: author.name,
      });
      attachmentsRef.current = [];
      reset();
      // CREATE-11: recipients are confirmed (server answers first, then mails in background).
      const notified = await notifyCreated(issue.issueKey, getAccessToken);
      onCreated(issue, notified);
    } catch (error) {
      setFormError(operationError(s, s.opCreate, error));
    } finally {
      setSubmitting(false);
    }
  };

  const areaOptions = AREA_OPTIONS.filter((a) => a.selectable || a.id === shownArea);

  return (
    <form
      className="iss-card flex flex-col gap-4 p-4"
      aria-labelledby="iss-create-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 id="iss-create-title" className="text-base font-semibold">{s.createTitle}</h2>
        <p className="text-xs iss-text-2">{s.createSubtitle}</p>
      </div>

      {restored ? (
        <div className="iss-warn-box flex items-center justify-between gap-2 px-3 py-2 text-sm" role="status">
          <span>{s.restored}</span>
          <button type="button" className="iss-btn px-2 py-1 text-xs" onClick={startOver}>{s.startOver}</button>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor="iss-title" className="text-sm font-medium">{s.fieldTitle}</label>
        <input
          id="iss-title"
          className="iss-input"
          value={form.title}
          placeholder={s.fieldTitlePlaceholder}
          onChange={(e) => update({ title: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="iss-desc" className="text-sm font-medium">{s.fieldDesc}</label>
        <textarea
          id="iss-desc"
          className="iss-input min-h-[112px] resize-y"
          value={form.description}
          placeholder={s.fieldDescPlaceholder}
          onChange={(e) => update({ description: e.target.value })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{s.fieldPurpose}</legend>
        <div className="grid grid-cols-4 gap-2">
          {PURPOSE_ORDER.map((p) => {
            const Icon = PURPOSE_ICON[p];
            return (
              <button
                key={p}
                type="button"
                className="iss-purpose-btn"
                aria-pressed={shownPurpose === p}
                onClick={() => update({ purposeOverride: p })}
              >
                <Icon width={18} height={18} aria-hidden />
                <span>{purposeLabel(p, lang)}</span>
              </button>
            );
          })}
        </div>
        {!form.purposeOverride && hasText ? <p className="text-xs iss-text-2">{s.reasonLine(suggestion.reason)}</p> : null}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="iss-area" className="text-sm font-medium">{s.fieldArea}</label>
        <select id="iss-area" className="iss-input" value={shownArea} onChange={(e) => update({ areaOverride: e.target.value })}>
          {areaOptions.map((a) => <option key={a.id} value={a.id}>{a[lang]}</option>)}
        </select>
      </div>

      <div
        className={`iss-drop flex flex-col items-center gap-2 px-3 py-4 text-center ${dragging ? 'iss-drop-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void uploadFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <span className="text-sm font-medium">{wide ? s.attachWide : s.attachNarrow}</span>
        <span className="text-xs iss-text-2">{s.attachHint}</span>
        <button type="button" className="iss-btn min-h-[44px]" onClick={() => fileInputRef.current?.click()}>{s.attachPick}</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.currentTarget.value = '';
            void uploadFiles(files);
          }}
        />
        <span aria-live="polite" className="text-xs iss-text-2">{uploading > 0 ? s.attachUploading : ''}</span>
      </div>

      <AttachmentThumbs
        attachments={form.attachments}
        urls={urls}
        layout="grid"
        onRemove={removeAttachment}
        removeLabel={s.attachRemoveLabel}
        removeText={s.attachRemove}
      />

      {formError ? <p role="alert" className="text-sm iss-danger">{formError}</p> : null}

      <button type="submit" className="iss-btn-primary w-full" disabled={submitting || uploading > 0}>
        {submitting ? s.submitting : s.submit}
      </button>
    </form>
  );
}

export function CreateSuccess({
  s, lang, issueKey, notifiedEmails, directory, onView, onNew,
}: {
  s: IssueStrings;
  lang: AppLanguage;
  issueKey: string;
  notifiedEmails: string[] | null;
  directory: DirectoryUser[];
  onView: () => void;
  onNew: () => void;
}) {
  const who = notifiedEmails ? describeRecipients(notifiedEmails, directory, lang) : '';
  const message = notifiedEmails === null ? s.doneNotifyFailed : notifiedEmails.length ? s.doneSent(who) : s.doneNoRecipients;
  return (
    <section role="status" className="iss-ok-box flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <CircleCheck width={22} height={22} aria-hidden />
        <h2 className="text-base font-semibold">
          {s.doneTitle('')}<span className="iss-mono">{issueKey}</span>
        </h2>
      </div>
      <p className="text-sm">{message}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="iss-btn-primary" onClick={onView}>{s.doneView}</button>
        <button type="button" className="iss-btn" onClick={onNew}>{s.doneNew}</button>
      </div>
    </section>
  );
}
