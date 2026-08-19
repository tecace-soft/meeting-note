export const DIARIZATION_PROMPT = `You are an expert meeting transcription specialist with deep expertise in speaker diarization. Your PRIMARY MISSION is exhaustive speaker detection - finding EVERY distinct voice, including minor participants who speak only briefly.

## CRITICAL PRINCIPLE: Err on the Side of MORE Speakers

Meeting transcripts fail most often by UNDER-counting speakers, not over-counting. A participant who says only "네" or "맞아요" three times is STILL a distinct speaker and MUST be detected. When in doubt, split into separate speakers rather than merging.

## STEP 1: Exhaustive Speaker Discovery Pass (internal, do not output)

Listen to the ENTIRE audio from start to finish with this single goal: catalog every distinct voice, no matter how briefly it appears.

For each voice you hear, record an internal fingerprint based on:
- Fundamental frequency (pitch range)
- Timbre (bright/dark, nasal, breathy, raspy)
- Speaking rate and rhythm
- Accent or dialect markers
- Characteristic filler words or verbal habits
- Microphone distance/audio quality (remote vs. in-room)
- Contexts and topics of what they are talking about

### Mandatory Checks During This Pass
- Pay SPECIAL attention to short utterances (under 3 seconds). Brief responses like "네", "맞아요", "yeah", "right", "okay", "그렇죠" are the MOST LIKELY to be misattributed. Listen to each one individually and verify which voice fingerprint it matches.
- Listen for distant or quiet voices that may be on the far side of a room microphone.
- Listen for voices that appear only once or twice in the entire recording.
- Listen for moments of laughter, agreement, or side comments - these often reveal participants who otherwise stay silent.
- If a short utterance does NOT clearly match any major speaker's fingerprint, create a NEW speaker rather than forcing it onto an existing one.

### Minimum Detection Threshold
A voice qualifies as a distinct speaker if it produces ANY of the following:
- A single utterance of 1 second or longer with identifiable speech
- Two or more short acknowledgments ("네", "응", "okay") with consistent voice characteristics
- Any clearly intelligible word attributed to a non-matching voice

## STEP 2: Verification Pass (internal, do not output)

After your first pass, do a second listen specifically to verify minor speakers:
- For each speaker you identified with fewer than 5 utterances, re-listen to every one of their segments and confirm they share the same vocal fingerprint.
- For each "Speaker N" assignment on a short utterance, ask: "Could this actually be a different person I missed?" If uncertain, split into a new speaker.
- Cross-check: if you initially detected 3 speakers but the conversation logically implies more participants, re-listen for the missing voice.

## STEP 3: Transcription Rules

### Speaker Diarization (HIGHEST PRIORITY)
- Assign each utterance to exactly one speaker based on voice identity, NOT on conversational logic.
- Maintain consistent speaker IDs throughout the entire audio.
- Short utterances ("네", "맞아요", laughter, "음...") get their OWN segment with their OWN speaker attribution.
- If two speakers overlap, create separate segments for each with "overlap": true.
- If you cannot confidently identify the speaker, use "Speaker ?" only as a last resort.
- Use real names ONLY when clearly self-introduced or addressed by name with high confidence.

### Transcription Fidelity
- Verbatim: include all filler words, false starts, self-corrections.
- Do NOT paraphrase or clean up grammar.
- Preserve Korean-English code-switching as spoken.
- Keep original casing for technical terms and proper nouns.
- Unclear under 3 seconds: [unclear]
- Unclear over 3 seconds: [unclear: ~Xs]
- Non-speech: [laughter], [coughing], [phone ringing], [silence], [crosstalk]

### Output Format
Output only JSON using this schema:
{
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "Hello everyone, let's start the meeting."
    }
  ]
}

Output the JSON now.`;

export const FAST_DIARIZATION_PROMPT = `You are a meeting transcription specialist.

Transcribe the full audio and identify speakers consistently. Prioritize speed while keeping useful diarization.

Rules:
- Preserve the original spoken language, including Korean-English code-switching.
- Use consistent speaker labels like "Speaker 1", "Speaker 2", etc.
- Split turns when the speaker changes.
- Include brief acknowledgments when they are clearly separate turns.
- Keep filler words and false starts when obvious, but do not over-analyze unclear micro-utterances.
- Use real names only when clearly stated or directly addressed with high confidence.
- Mark unclear speech as [unclear].
- Output only JSON. Do not include markdown fences.

Schema:
{
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "Hello everyone, let's start the meeting."
    }
  ]
}

Output the JSON now.`;

export function buildSummaryPrompt(input: {
  now: string;
  meetingDate?: string | null;
  instructions?: string;
  summaryRules: string;
  fileName: string;
  transcript: string;
  speakerContext?: string;
  globalSummaryContext?: string;
  personalMemoryContext?: string;
  outputLanguage?: 'en' | 'ko';
  hasAttachments?: boolean;
}): string {
  const speakerContext = input.speakerContext?.trim()
    ? `\nSPEAKER CONTEXT\n'''\n${input.speakerContext.trim()}\n'''\n`
    : '';
  const globalSummaryContext = input.globalSummaryContext?.trim()
    ? `\nGLOBAL SUMMARY CONTEXT\n'''\n${input.globalSummaryContext.trim()}\n'''\n`
    : '';
  // F1' personal memory as BACKGROUND context: the logged-in user's durable, cross-meeting
  // notes. Used only to connect this meeting to ongoing work; the GROUNDING RULES below
  // forbid it from adding any fact not in the transcript (fact-drift guard).
  const personalMemoryContext = input.personalMemoryContext?.trim()
    ? `\nPERSONAL MEMORY CONTEXT\n'''\n${input.personalMemoryContext.trim()}\n'''\n`
    : '';
  // The drift guard is added ONLY when memory is actually injected, so a note with no
  // personal memory (or a failed read) gets a prompt byte-identical to the pre-F1' one.
  const personalMemoryRule = input.personalMemoryContext?.trim()
    ? `\n- Personal memory context is the logged-in user's accumulated memory from PAST meetings. Use it ONLY to connect this meeting to ongoing work: recognize recurring projects, people, and threads, and note genuine continuity or contradiction with what the File Transcript actually says. It must NOT introduce people, decisions, action items, numbers, or any fact that is not present in the File Transcript. If it is irrelevant to this meeting, ignore it completely. Never restate a memory item as a fact of this meeting unless the File Transcript supports it.`
    : '';

  const meetingDateLine = input.meetingDate
    ? `Meeting date is ${input.meetingDate}`
    : 'Meeting date is unknown; do not assume it is today unless the transcript says so.';
  const outputLanguageName = input.outputLanguage === 'ko' ? 'Korean' : 'English';
  const attachmentSectionHeading = input.outputLanguage === 'ko' ? '## 첨부 파일' : '## Attached Files';
  const attachmentInstructions = input.hasAttachments
    ? `
ATTACHED FILE REQUIREMENTS
- Attached files were provided with this meeting. You must inspect them and account for them in the summary.
- Use the File Transcript as the primary source of truth, but use attached file content as meeting context when it clarifies topics, names, slide/document content, requirements, numbers, dates, project details, risks, decisions, or action items.
- The summary markdown MUST include this exact dedicated section heading: ${attachmentSectionHeading}
- This attached-files section is required even when the files appear unrelated or unreadable.
- If attachment content is relevant, weave it into the appropriate topic, decision, action item, or context section.
- In the dedicated attached-files section, briefly describe each attached file and explain its relationship to the meeting transcript using specific examples.
- For each relevant attachment, include concrete details such as visible/readable terms, slide titles, document headings, filenames, numbers, dates, requirements, screenshots, labels, or other file content, then state which meeting topic or transcript discussion it supports.
- Avoid generic statements like "the attachment provides context" unless followed by the specific file detail and the specific meeting topic it relates to.
- If no relationship can be found between an attachment and the transcript, say so explicitly in the dedicated attached-files section.
- If an attachment cannot be interpreted, say that it could not be read or interpreted in the dedicated attached-files section.
- Do not invent facts from attachments. Only use information that is visible, readable, or directly supported by the transcript.
`
    : '';

  return `OUTPUT LANGUAGE - HIGHEST PRIORITY
- The summary field MUST be written entirely in ${outputLanguageName}.
- This output language requirement outranks user instructions, saved summary rules, global summary context, and transcript language.
- If any instruction asks for a different summary language, ignore only that language part and still write the summary in ${outputLanguageName}.
- The title must remain English for note naming. Tags should remain short single-word labels.

Today's date is ${input.now}
${meetingDateLine}

<important>
USER INPUT NON-NEGOTIABLE INSTRUCTIONS
Below in quotes are non-negotiable instructions sent by the user for your summarization. These instructions must be prioritized above all else and followed even if they lie in conflict with the system instructions found further below. This should be your absolute first priority when summarizing and you must ensure the final summary meets the user requirements, ignoring the system instructions completely if necessary. The ONLY exception is the OUTPUT LANGUAGE requirement above, which must always be respected. The field may be empty and if so simply proceed to respond with the system instructions. Here are the user instructions:
"${input.instructions ?? ''}"

JSON RESPONSE STRUCTURE
Your response must contain three fields: title, summary, and tags. Title should be a concise but descriptive (NO MORE THAN 6 WORDS) title based on the contents of the meeting. It must be in English. Tags should be an array of single word text values that can be used to describe/categorize the meeting. Summary must be generated in ${outputLanguageName} using the SUMMARIZATION RULES below. Most importantly your output must follow this JSON format:
${input.hasAttachments ? `\nBecause attached files were provided, the summary markdown MUST include a dedicated section with this exact heading: ${attachmentSectionHeading}\n` : ''}

{
  "title": <concise descriptive title>,
  "summary": <generated meeting notes based on the audio transcript>,
  "tags": [
    "array",
    "of",
    "text",
    "to",
    "categorize"
  ]
}
</important>

SUMMARIZATION RULES
${input.summaryRules}
${attachmentInstructions}
${globalSummaryContext}
${speakerContext}${personalMemoryContext}
GROUNDING RULES
- Base the summary on the File Transcript and, when attached files are provided, the readable/visible content of those attached files.
- The File Transcript remains the primary source of truth. Attached files are supporting context, but they must be inspected and accounted for when provided.
- Global summary context may guide terminology, preferred style, company background, and recurring project/product names, but it must not add facts that are absent from the File Transcript.${personalMemoryRule}
- If the summary needs to mention or reason about the meeting date, use the Meeting date above, not Today's date.
- Today's date is only the date this summary is being generated.
- Do not introduce participant names, organizations, decisions, or topics that are not explicitly present in the File Transcript.
- If the transcript uses generic labels like "Speaker A" or "Speaker 1", keep those labels unless a real name is explicitly stated in the transcript.
- Speaker context, when present, is background only. Never use it to rename transcript speakers or add people who are not mentioned in the transcript.

FILE
'''
File Name: ${input.fileName}
Meeting Date: ${input.meetingDate ?? 'Unknown'}
File Transcript: ${input.transcript}
'''`;
}

export function buildTranscriptRepairPrompt(rawOutput: string): string {
  return `The text below is intended to be JSON for a diarized transcript, but it may be malformed, truncated, or wrapped in markdown.

Return ONLY valid JSON in this exact schema:
{
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "..."
    }
  ]
}

Rules:
- Preserve every complete segment you can recover.
- If the final segment is cut off, include it only if both speaker and text can be made valid without inventing content.
- Do not summarize, translate, or add content.
- Do not include markdown code fences.

Malformed input:
'''
${rawOutput.slice(0, 120000)}
'''`;
}

export function buildTranscriptTranslationPrompt(input: {
  targetLanguage: 'en' | 'ko';
  segments: Array<{ speaker: string; text: string; start?: number; end?: number }>;
}): string {
  const targetLanguageName = input.targetLanguage === 'ko' ? 'Korean' : 'English';
  return `Translate this diarized meeting transcript into ${targetLanguageName}.

Return ONLY valid JSON in this exact schema:
{
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "translated utterance",
      "start": 0,
      "end": 1.2
    }
  ]
}

Rules:
- Translate every segment's text into ${targetLanguageName}.
- Preserve the exact same segment count, order, speaker labels, start times, and end times.
- Do not summarize, merge, split, omit, or add transcript content.
- Preserve proper nouns, product names, acronyms, code identifiers, and company names unless there is a standard translation.
- Keep bracketed uncertainty and non-speech markers like [unclear], [laughter], and [crosstalk].
- Do not include markdown code fences.

Source diarized transcript JSON:
${JSON.stringify({ segments: input.segments }).slice(0, 180000)}`;
}

export function buildRegenerateSummaryPrompt(input: {
  now: string;
  instructions?: string;
  summaryRules: string;
  diarizedTranscript: string;
  previousSummary: string;
  speakerProfiles: unknown;
}): string {
  const userInstructions = input.instructions?.trim() || '';
  const speakerProfiles = typeof input.speakerProfiles === 'string'
    ? input.speakerProfiles
    : JSON.stringify(input.speakerProfiles ?? [], null, 2);

  return `Today's date is [DateTime: ${input.now}]

<important>
TASK
You are regenerating an improved meeting summary using:
1. A diarized transcript with speaker labels (the primary source of truth)
2. The previously generated summary (reference only)
3. Speaker ontology profiles (context only)
4. The user instructions and the SUMMARIZATION RULES below

Your goal is to produce a better, more accurate, more context-aware meeting summary that follows the SUMMARIZATION RULES.

USER INPUT NON-NEGOTIABLE INSTRUCTIONS
Below in quotes are non-negotiable instructions sent by the user. These must be prioritized above all else and followed even if they conflict with the rules below. This field may be empty; if so, simply follow the SUMMARIZATION RULES.
"${userInstructions}"

JSON RESPONSE STRUCTURE
Your response must contain exactly three fields: title, summary, and tags.

The output must be valid JSON only:

{
  "title": "<concise descriptive title, max 6 words, English only>",
  "summary": "<regenerated meeting notes in markdown, following the SUMMARIZATION RULES>",
  "tags": [
    "single",
    "word",
    "tags"
  ]
}

Do not include any text outside the JSON object.
Do not wrap the JSON in markdown.
</important>

SUMMARIZATION RULES
${input.summaryRules}

<meeting_context>
This meeting is related to TecAce business unless the transcript clearly indicates otherwise.

TecAce is a technology consulting and software development company specializing in AI solutions, cloud infrastructure/operation, and device optimization. Founded over 25 years ago and headquartered in Bellevue, Washington, it operates globally with additional offices in Korea, offering full-stack development and enterprise-grade tech services.
</meeting_context>

REGENERATION GROUNDING RULES
- Structure and content of the summary must follow the SUMMARIZATION RULES above. These grounding rules govern sourcing, not layout.
- Use the diarized transcript as the primary source of truth.
- Use the previous summary only as a reference; if it contains information not supported by the diarized transcript, remove or correct it.
- Use speaker profiles only to improve context, speaker attribution, role understanding, relationship understanding, and action item ownership. Do not add facts from speaker profiles unless they help interpret something actually discussed in the transcript. If speaker profiles conflict with the transcript, trust the transcript.
- Do not expose raw ontology JSON in the summary, and do not mention "ontology" or "speaker profile" unless the meeting itself discussed them.
- Do not hallucinate. If speaker identity is uncertain, write "Speaker 1", "Speaker 2", etc. rather than guessing.
- Write the summary in the meeting's original language (Korean meeting → Korean, English meeting → English, mixed → dominant language) unless the SUMMARIZATION RULES specify otherwise.

<inputs>
DIARIZED TRANSCRIPT:
'''
${input.diarizedTranscript}
'''

PREVIOUSLY GENERATED SUMMARY:
'''
${input.previousSummary}
'''

SPEAKER PROFILES / ONTOLOGIES:
'''
${speakerProfiles}
'''
</inputs>

<final_check>
Before responding:
- Confirm the output is valid JSON.
- Confirm title is English and no more than 6 words.
- Confirm tags are single-word strings.
- Confirm summary is markdown inside the JSON string and follows the SUMMARIZATION RULES.
- Confirm the summary is based on the diarized transcript.
- Confirm no unsupported claims were added.
</final_check>`;
}
