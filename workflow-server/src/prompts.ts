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
  instructions?: string;
  summaryRules: string;
  fileName: string;
  transcript: string;
  speakerContext?: string;
}): string {
  const speakerContext = input.speakerContext?.trim()
    ? `\nSPEAKER CONTEXT\n'''\n${input.speakerContext.trim()}\n'''\n`
    : '';

  return `Today's date is ${input.now}

<important>
USER INPUT NON-NEGOTIABLE INSTRUCTIONS
Below in quotes are non-negotiable instructions sent by the user for your summarization. These instructions must be prioritized above all else and followed even if they lie in conflict with the system instructions found further below. This should be your absolute first priority when summarizing and you must ensure the final summary meets the user requirements, ignoring the system instructions completely if necessary. The field may be empty and if so simply proceed to respond with the system instructions. Here are the user instructions:
"${input.instructions ?? ''}"

JSON RESPONSE STRUCTURE
Your response must contain three fields: title, summary, and tags. Title should be a concise but descriptive (NO MORE THAN 6 WORDS) title based on the contents of the meeting. It must be in English (regardless of the summary language). Tags should be an array of single word text values that can be used to describe/categorize the meeting. Summary can be generated using the SUMMARIZATION RULES below. Most importantly your output must follow this JSON format:

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
${speakerContext}
GROUNDING RULES
- Base the summary only on the File Transcript.
- Do not introduce participant names, organizations, decisions, or topics that are not explicitly present in the File Transcript.
- If the transcript uses generic labels like "Speaker A" or "Speaker 1", keep those labels unless a real name is explicitly stated in the transcript.
- Speaker context, when present, is background only. Never use it to rename transcript speakers or add people who are not mentioned in the transcript.

FILE
'''
File Name: ${input.fileName}
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
