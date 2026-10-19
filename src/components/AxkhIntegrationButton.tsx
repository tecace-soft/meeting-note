import React from 'react';
import { Users } from 'react-coolicons';

interface Props {
  /** True once the note has a summary; the entry point then becomes the prominent send call-to-action. */
  summaryReady: boolean;
  language: 'en' | 'ko';
  className: string;
  labelClassName: string;
  onOpen: () => void;
}

/** Post-recording entry point: needs the feature flag, a saved note id, a signed-in owner, and a finished non-empty summary. */
export function shouldShowAxkhEntry(input: { uiEnabled: boolean; noteId: string | null; ownerKnown: boolean;
  summarizing: boolean; summary: string | null | undefined }): boolean {
  return input.uiEnabled && !!input.noteId && input.ownerKnown && !input.summarizing && !!input.summary?.trim();
}

/** Opens the AXKH modal. Never sends by itself: the owner confirms inside the modal (no automatic send). */
const AxkhIntegrationButton: React.FC<Props> = ({ summaryReady, language, className, labelClassName, onOpen }) => {
  const ko = language === 'ko';
  const title = summaryReady ? (ko ? 'AXKH로 보내기' : 'Send to AXKH') : (ko ? 'AXKH 연동 · 참석 확인' : 'AXKH integration · attendance');
  const label = summaryReady ? (ko ? 'AXKH로 보내기' : 'Send to AXKH') : (ko ? 'AXKH 연동' : 'AXKH integration');
  return (
    <button type="button" onClick={onOpen} className={className} title={title} aria-label={title}
      data-prominent={summaryReady ? 'true' : undefined}
      style={summaryReady ? { backgroundColor: 'var(--accent)', color: 'var(--accent-contrast, #fff)', fontWeight: 600 } : undefined}>
      <Users className="h-4 w-4 shrink-0" aria-hidden />
      <span className={labelClassName}>{label}</span>
    </button>
  );
};
export default AxkhIntegrationButton;
