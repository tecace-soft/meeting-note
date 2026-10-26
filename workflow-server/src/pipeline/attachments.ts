// Gemini file attachments for the summarize stage: uploads the user's attached files,
// builds the attachment context part, and generates (or falls back to) the required
// attached-files section of the summary. Imports only shared config and AI modules
// (never index.ts or routes).
import { env } from '../config/env.js';
import { callGeminiWithFallback, type GeminiWorkflowCallResult } from '../ai/geminiFallback.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { callGemini, uploadGeminiFile } from '../gemini.js';
import { stripJsonCodeFences } from '../parsers.js';
import type { SummaryAttachmentInput } from './types.js';

export async function buildGeminiAttachmentParts(attachments: SummaryAttachmentInput[]): Promise<Parameters<typeof callGemini>[0]['parts']> {
  if (attachments.length === 0) return [];

  const uploaded: Array<{ name: string; mimeType: string; fileUri: string }> = [];
  for (const attachment of attachments) {
    const bytes = Uint8Array.from(Buffer.from(attachment.dataBase64, 'base64'));
    if (bytes.byteLength === 0) continue;
    const file = await uploadGeminiFile({
      apiKey: env.geminiApiKey,
      displayName: attachment.name,
      mimeType: attachment.mimeType,
      bytes,
    });
    uploaded.push({ name: attachment.name, mimeType: file.mimeType, fileUri: file.fileUri });
  }

  if (uploaded.length === 0) return [];

  return [
    {
      text: `ATTACHED FILE CONTEXT
The user attached ${uploaded.length} file${uploaded.length === 1 ? '' : 's'} from the meeting. You must inspect every attached file and look for information that relates to the diarized transcript.
Attached files:
${uploaded.map((file, index) => `${index + 1}. ${file.name} (${file.mimeType})`).join('\n')}
- Treat the transcript as the primary source of truth, but actively use attached files to clarify meeting topics, names, documents, slide content, screenshots, requirements, numbers, dates, project context, risks, decisions, and action items.
- Extract visible or readable content from attached PDFs, text/CSV/JSON/HTML files, images, audio, and video. Connect that content to the transcript wherever a reasonable relationship exists.
- When attachment content is relevant, incorporate it naturally into the appropriate summary section instead of creating a disconnected file summary.
- The summary must contain a dedicated attached-files section. Do not omit this section.
- Do not invent decisions, dates, participants, or action items from attachments unless they are explicitly visible/readable in a file or supported by the transcript.
- If attachments are provided but no relationship to the meeting can be found, include a short note in the summary stating what the attached file(s) appear to be and that no clear relationship to the meeting transcript was found.
- If an attachment is unreadable, include a short note that the file could not be interpreted rather than silently ignoring it.
`,
    },
    ...uploaded.map((file) => ({
      fileData: {
        mimeType: file.mimeType,
        fileUri: file.fileUri,
      },
    })),
  ];
}

export function attachmentSectionHeading(language: 'en' | 'ko'): string {
  return language === 'ko' ? '## 첨부 파일' : '## Attached Files';
}

export function summaryHasAttachmentSection(summary: string, language: 'en' | 'ko'): boolean {
  const exactHeading = attachmentSectionHeading(language).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${exactHeading}\\s*$`, 'im').test(summary);
}

export function parseAttachmentSection(raw: string, language: 'en' | 'ko'): string {
  const parsed = JSON.parse(stripJsonCodeFences(raw)) as unknown;
  const sectionMarkdown = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { sectionMarkdown?: unknown }).sectionMarkdown
    : null;
  const heading = attachmentSectionHeading(language);
  const section = typeof sectionMarkdown === 'string' ? sectionMarkdown.trim() : '';
  if (!section) throw new Error('Attachment section JSON must include sectionMarkdown.');
  return section.startsWith(heading) ? section : `${heading}\n${section}`;
}

export function fallbackAttachmentSection(attachments: SummaryAttachmentInput[], language: 'en' | 'ko'): string {
  const heading = attachmentSectionHeading(language);
  const fileLines = attachments.length > 0
    ? attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}): ${language === 'ko'
      ? '첨부 파일이 제공되었지만 이 실행에서 회의 기록과의 관계 분석을 완료하지 못했습니다.'
      : 'This file was attached, but its relationship to the transcript could not be analyzed in this run.'}`)
    : [`- ${language === 'ko'
      ? '첨부 파일이 제공되었지만 이 실행에서 파일 정보를 확인하지 못했습니다.'
      : 'Attachments were provided, but file details could not be confirmed in this run.'}`];
  return `${heading}\n${fileLines.join('\n')}`;
}

export async function generateAttachmentSummarySection(input: {
  attachmentParts: Parameters<typeof callGemini>[0]['parts'];
  attachments: SummaryAttachmentInput[];
  transcriptText: string;
  existingSummary: string;
  language: 'en' | 'ko';
}): Promise<GeminiWorkflowCallResult> {
  const heading = attachmentSectionHeading(input.language);
  const outputLanguageName = input.language === 'ko' ? 'Korean' : 'English';

  return callGeminiWithFallback({
    stage: 'Attachment section generation',
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
    parts: [
      {
        text: `Generate the required attached-files section for a meeting summary.

OUTPUT LANGUAGE
- Write the section in ${outputLanguageName}.

REQUIRED OUTPUT
Return valid JSON only:
{
  "sectionMarkdown": "${heading}\\n- ..."
}

SECTION RULES
- The sectionMarkdown value MUST start with this exact heading: ${heading}
- Inspect every attached file provided in the fileData parts.
- Compare the attached file content against the transcript and existing summary.
- Briefly describe each attached file and explain how it relates to the meeting transcript using specific examples.
- For each relevant file, include concrete visible/readable details from the file, such as terms, headings, slide titles, document sections, filenames, numbers, dates, requirements, screenshots, labels, or other exact content.
- For each concrete file detail, name the meeting topic, transcript discussion, decision, risk, or action item that it supports or clarifies.
- Avoid vague statements like "the file provides context" unless followed by the specific file detail and the specific meeting topic it relates to.
- If a file has no clear relationship to the transcript, say that explicitly.
- If a file cannot be interpreted, say that explicitly.
- Do not invent facts. Use only visible/readable file content and the transcript.

ATTACHED FILES
${input.attachments.map((attachment, index) => `${index + 1}. ${attachment.name} (${attachment.mimeType})`).join('\n')}

TRANSCRIPT
'''
${input.transcriptText}
'''

CURRENT SUMMARY
'''
${input.existingSummary}
'''`,
      },
      ...input.attachmentParts,
    ],
  });
}
