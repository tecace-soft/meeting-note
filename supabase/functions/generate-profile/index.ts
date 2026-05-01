import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestBody {
  speakerName: string;
  speakerId?: string;
  transcriptText: string;
  existingProfile?: string | null;
  /** Optional override (e.g. local dev). Prefer GEMINI_API_KEY secret on the function. */
  apiKey?: string;
}

/** Override with `GEMINI_MODEL` secret. If a model 404s, set e.g. `gemini-2.0-flash` or `gemini-2.5-flash`. */
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

function extractGeminiOutputText(data: GeminiGenerateContentResponse): string {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) return '';
  return parts.map((p) => p.text ?? '').join('');
}

async function callGeminiGenerateContent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ rawText: string; error?: string; status?: number }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });

  const responseBody = await res.text();
  let data: GeminiGenerateContentResponse;
  try {
    data = JSON.parse(responseBody) as GeminiGenerateContentResponse;
  } catch {
    return {
      rawText: '',
      error: `Gemini API error (${res.status}): ${responseBody.slice(0, 500)}`,
      status: res.status || 502,
    };
  }
  if (!res.ok) {
    const msg = data.error?.message ?? responseBody.slice(0, 500);
    return { rawText: '', error: `Gemini API error (${res.status}): ${msg}`, status: res.status };
  }
  if (data.error?.message) {
    return { rawText: '', error: `Gemini API error: ${data.error.message}`, status: res.status };
  }
  if (data.promptFeedback?.blockReason) {
    return {
      rawText: '',
      error: `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`,
      status: 400,
    };
  }
  const rawText = extractGeminiOutputText(data).trim();
  if (!rawText) {
    const fr = data.candidates?.[0]?.finishReason;
    const reason = fr ? ` (finishReason: ${fr})` : '';
    return {
      rawText: '',
      error: `Gemini returned empty output.${reason} Check model name (GEMINI_MODEL) and API key.`,
      status: 502,
    };
  }
  return { rawText };
}

interface SpeakerOntology {
  schema_version: string;
  speaker_id: string;
  display_name: string;
  aliases: string[];
  identity_confidence: number;
  professional_context: {
    company: string;
    role: string;
    domains: string[];
    confidence: number;
  };
  active_projects: {
    name: string;
    role_in_project: string;
    status: string;
    importance: string;
    confidence: number;
  }[];
  relationships: {
    person_or_group: string;
    relationship_type: string;
    context: string;
    related_projects: string[];
    confidence: number;
  }[];
  responsibilities: {
    description: string;
    scope: string;
    related_projects: string[];
    status: string;
    confidence: number;
  }[];
  open_threads: {
    topic: string;
    status: string;
    priority: string;
    summary: string;
    related_projects: string[];
    confidence: number;
  }[];
  evidence: {
    source: string;
    quote_or_paraphrase: string;
    supports: string[];
    confidence: number;
  }[];
  last_updated_at: string;
}

function clampConfidence01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function mapProfessionalContext(pc: Record<string, unknown>): SpeakerOntology['professional_context'] {
  return {
    company: typeof pc.company === 'string' ? pc.company : '',
    role: typeof pc.role === 'string' ? pc.role : '',
    domains: Array.isArray(pc.domains) ? pc.domains.filter((x): x is string => typeof x === 'string') : [],
    confidence: clampConfidence01(pc.confidence),
  };
}

function mapActiveProject(o: Record<string, unknown>): SpeakerOntology['active_projects'][number] {
  return {
    name: typeof o.name === 'string' ? o.name : '',
    role_in_project: typeof o.role_in_project === 'string' ? o.role_in_project : '',
    status: typeof o.status === 'string' ? o.status : '',
    importance: typeof o.importance === 'string' ? o.importance : '',
    confidence: clampConfidence01(o.confidence),
  };
}

function mapRelationship(o: Record<string, unknown>): SpeakerOntology['relationships'][number] {
  return {
    person_or_group: typeof o.person_or_group === 'string' ? o.person_or_group : '',
    relationship_type: typeof o.relationship_type === 'string' ? o.relationship_type : '',
    context: typeof o.context === 'string' ? o.context : '',
    related_projects: Array.isArray(o.related_projects)
      ? o.related_projects.filter((x): x is string => typeof x === 'string')
      : [],
    confidence: clampConfidence01(o.confidence),
  };
}

function mapResponsibility(o: Record<string, unknown>): SpeakerOntology['responsibilities'][number] {
  return {
    description: typeof o.description === 'string' ? o.description : '',
    scope: typeof o.scope === 'string' ? o.scope : '',
    related_projects: Array.isArray(o.related_projects)
      ? o.related_projects.filter((x): x is string => typeof x === 'string')
      : [],
    status: typeof o.status === 'string' ? o.status : '',
    confidence: clampConfidence01(o.confidence),
  };
}

function mapOpenThread(o: Record<string, unknown>): SpeakerOntology['open_threads'][number] {
  return {
    topic: typeof o.topic === 'string' ? o.topic : '',
    status: typeof o.status === 'string' ? o.status : '',
    priority: typeof o.priority === 'string' ? o.priority : '',
    summary: typeof o.summary === 'string' ? o.summary : '',
    related_projects: Array.isArray(o.related_projects)
      ? o.related_projects.filter((x): x is string => typeof x === 'string')
      : [],
    confidence: clampConfidence01(o.confidence),
  };
}

function mapEvidence(o: Record<string, unknown>): SpeakerOntology['evidence'][number] {
  return {
    source: typeof o.source === 'string' ? o.source : '',
    quote_or_paraphrase: typeof o.quote_or_paraphrase === 'string' ? o.quote_or_paraphrase : '',
    supports: Array.isArray(o.supports) ? o.supports.filter((x): x is string => typeof x === 'string') : [],
    confidence: clampConfidence01(o.confidence),
  };
}

function mapObjectArray<T>(arr: unknown, fn: (o: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(arr)) return [];
  const out: T[] = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(fn(item as Record<string, unknown>));
    }
  }
  return out;
}

function fallbackOntology(speakerName: string, speakerId: string): SpeakerOntology {
  return {
    schema_version: '1.0',
    speaker_id: speakerId,
    display_name: speakerName,
    aliases: [],
    identity_confidence: 0,
    professional_context: { company: '', role: '', domains: [], confidence: 0 },
    active_projects: [],
    relationships: [],
    responsibilities: [],
    open_threads: [],
    evidence: [],
    last_updated_at: new Date().toISOString(),
  };
}

/** Detect legacy markdown profiles (non-JSON strings). */
function isMarkdownProfile(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[');
}

/** Wrap a legacy markdown profile into a minimal ontology. */
function wrapMarkdownProfile(raw: string, speakerName: string, speakerId: string): SpeakerOntology {
  const summary = raw.trim();
  return {
    ...fallbackOntology(speakerName, speakerId),
    evidence: summary
      ? [
          {
            source: 'transcript',
            quote_or_paraphrase: summary,
            supports: ['legacy_profile_migration'],
            confidence: 0,
          },
        ]
      : [],
  };
}

/** Strip deprecated keys and normalize before passing existing profile into the update prompt. */
function sanitizeExistingOntologyForUpdate(raw: string, speakerName: string, speakerId: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    delete parsed.summary_for_meeting_context;
    const normalized = parseOntologyResponse(JSON.stringify(parsed), speakerName, speakerId);
    return JSON.stringify(normalized, null, 2);
  } catch {
    return stripped;
  }
}

/** Allowlisted parse — never preserves summary_for_meeting_context or other unknown keys. */
function ontologyFromLooseParsed(parsed: Record<string, unknown>, speakerName: string, speakerId: string): SpeakerOntology {
  const pcRaw = parsed.professional_context;
  const professional_context =
    pcRaw && typeof pcRaw === 'object' && !Array.isArray(pcRaw)
      ? mapProfessionalContext(pcRaw as Record<string, unknown>)
      : mapProfessionalContext({});
  return {
    schema_version: typeof parsed.schema_version === 'string' ? parsed.schema_version : '1.0',
    speaker_id: typeof parsed.speaker_id === 'string' ? parsed.speaker_id : speakerId,
    display_name: typeof parsed.display_name === 'string' ? parsed.display_name : speakerName,
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((x): x is string => typeof x === 'string') : [],
    identity_confidence: typeof parsed.identity_confidence === 'number' ? parsed.identity_confidence : 0,
    professional_context,
    active_projects: mapObjectArray(parsed.active_projects, mapActiveProject),
    relationships: mapObjectArray(parsed.relationships, mapRelationship),
    responsibilities: mapObjectArray(parsed.responsibilities, mapResponsibility),
    open_threads: mapObjectArray(parsed.open_threads, mapOpenThread),
    evidence: mapObjectArray(parsed.evidence, mapEvidence),
    last_updated_at: typeof parsed.last_updated_at === 'string' ? parsed.last_updated_at : new Date().toISOString(),
  };
}

function parseOntologyResponse(raw: string, speakerName: string, speakerId: string): SpeakerOntology {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    return ontologyFromLooseParsed(parsed, speakerName, speakerId);
  } catch (e) {
    console.error('Failed to parse ontology JSON. Raw output:', raw, 'Error:', e);
    return fallbackOntology(speakerName, speakerId);
  }
}

const CONFIDENCE_RULES = `Confidence scores (0.0–1.0):
- Every object value must include a numeric field "confidence" in that object (not at the root except identity_confidence).
- professional_context.confidence reflects confidence in company/role/domains as a whole.
- Each item in active_projects, relationships, responsibilities, open_threads, and evidence must have its own "confidence" for that item's inferred content.
- 1.0 = stated explicitly in the transcript; ~0.5–0.8 = strongly implied; lower for weak inference; 0.0 when the block is empty or has no transcript support.`;

const NEW_PROFILE_SYSTEM = `You are a speaker ontology extraction engine for a meeting note application.

Your job is to create a practical, lightweight speaker memory ontology from a diarized meeting transcript.

The goal is not to create a perfect academic ontology. The goal is to create structured speaker context that helps future meeting notes become more accurate, relevant, and consistent.

${CONFIDENCE_RULES}

Your JSON output must contain ONLY the keys shown in the required structure. Never output summary_for_meeting_context or any other key not listed there.`;

const UPDATE_PROFILE_SYSTEM = `You are a speaker ontology update engine for a meeting note application.

Your job is to update an existing lightweight speaker memory ontology using a new diarized meeting transcript.

The goal is to preserve useful speaker context while adding new professional information that improves future meeting summaries.

${CONFIDENCE_RULES}

Never output deprecated fields. The field summary_for_meeting_context is not part of the schema and must not appear in your JSON output.`;

function requiredOntologyJsonSchema(speakerId: string, displayName: string, lastUpdated: string): string {
  return `{
  "schema_version": "1.0",
  "speaker_id": "${speakerId}",
  "display_name": "${displayName}",
  "aliases": [],
  "identity_confidence": 0.0,
  "professional_context": {
    "company": "",
    "role": "",
    "domains": [],
    "confidence": 0.0
  },
  "active_projects": [
    {
      "name": "",
      "role_in_project": "",
      "status": "active | paused | completed | unknown",
      "importance": "high | medium | low | unknown",
      "confidence": 0.0
    }
  ],
  "relationships": [
    {
      "person_or_group": "",
      "relationship_type": "collaborator | customer | manager | team_member | vendor | stakeholder | unknown",
      "context": "",
      "related_projects": [],
      "confidence": 0.0
    }
  ],
  "responsibilities": [
    {
      "description": "",
      "scope": "general | project-specific | meeting-specific",
      "related_projects": [],
      "status": "active | completed | unknown",
      "confidence": 0.0
    }
  ],
  "open_threads": [
    {
      "topic": "",
      "status": "open | waiting | resolved | unknown",
      "priority": "high | medium | low | unknown",
      "summary": "",
      "related_projects": [],
      "confidence": 0.0
    }
  ],
  "evidence": [
    {
      "source": "transcript",
      "quote_or_paraphrase": "",
      "supports": [],
      "confidence": 0.0
    }
  ],
  "last_updated_at": "${lastUpdated}"
}`;
}

function buildNewProfilePrompt(name: string, speakerId: string, transcript: string, currentDate: string): string {
  return `Create a new speaker ontology for ${name} using the meeting transcript below.

Rules:
- Use only information that is explicitly stated or strongly supported by the transcript.
- Do not invent personal details, titles, companies, relationships, or responsibilities.
- Prefer useful business/professional context over personality analysis.
- Avoid storing sensitive personal information.
- If a field is unknown, use an empty string, empty array, or set the containing object's confidence to 0.0.
- Include every "confidence" field shown in the structure for professional_context and each array item.
- Keep the ontology compact and useful for downstream meeting notes.
- Output valid JSON only. Do not output markdown.
- Output ONLY the keys in the required structure below. Never output summary_for_meeting_context or any other extra key.

Required JSON structure:
${requiredOntologyJsonSchema(speakerId, name, currentDate)}

Transcript:
${transcript}`;
}

function buildUpdateProfilePrompt(
  name: string,
  speakerId: string,
  existingOntologyJson: string,
  transcript: string,
  currentDate: string
): string {
  return `Update the existing ontology for ${name} using the new transcript below.

Rules:
- Keep existing information unless the new transcript clearly updates or corrects it.
- Prefer newer transcript information when there is a direct conflict.
- Do not duplicate projects, relationships, responsibilities, or open threads.
- Merge similar items instead of creating near-duplicates.
- Use only information that is explicitly stated or strongly supported.
- Do not add sensitive personal information.
- Keep the ontology compact and useful for downstream meeting notes.
- Output valid JSON only. Do not output markdown.
- Output ONLY the keys in the required structure below. Never output summary_for_meeting_context or any other extra key, even if it appeared in the existing ontology.
- Refresh confidence scores on merge: each object's confidence should reflect current transcript support for that block.

Merge behavior:
- If the same project appears again, update its role, status, or importance only if the new transcript adds useful information.
- If the same relationship appears again, enrich the context instead of duplicating it.
- If a responsibility is repeated, keep one clear version.
- If an open thread is resolved, change its status to "resolved".
- If a new unresolved topic appears, add it to open_threads.
- Add short evidence entries only for important new or changed facts.
- Update last_updated_at to "${currentDate}".

Required JSON structure (same shape as new profiles; fill arrays/objects according to merged content):
${requiredOntologyJsonSchema(speakerId, name, currentDate)}

Existing ontology:
${existingOntologyJson}

New transcript:
${transcript}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const body = (await req.json()) as RequestBody;
    const { speakerName, speakerId = '', transcriptText, existingProfile, apiKey: bodyApiKey } = body;

    const apiKey =
      Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GOOGLE_API_KEY') ?? bodyApiKey ?? '';
    const model = (Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL).trim();
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            'No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) as a Supabase secret, or pass apiKey from the client.',
        }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    if (!speakerName || !transcriptText) {
      return new Response(JSON.stringify({ error: 'speakerName and transcriptText are required.' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const currentDate = new Date().toISOString();
    const resolvedSpeakerId = speakerId || speakerName.toLowerCase().replace(/\s+/g, '_');

    // Resolve existing profile: convert legacy markdown → minimal ontology JSON if needed
    let existingOntologyJson: string | null = null;
    if (existingProfile && existingProfile.trim()) {
      if (isMarkdownProfile(existingProfile)) {
        const wrapped = wrapMarkdownProfile(existingProfile, speakerName, resolvedSpeakerId);
        existingOntologyJson = JSON.stringify(wrapped, null, 2);
      } else {
        existingOntologyJson = sanitizeExistingOntologyForUpdate(existingProfile.trim(), speakerName, resolvedSpeakerId);
      }
    }

    const systemPrompt = existingOntologyJson ? UPDATE_PROFILE_SYSTEM : NEW_PROFILE_SYSTEM;
    const userPrompt = existingOntologyJson
      ? buildUpdateProfilePrompt(speakerName, resolvedSpeakerId, existingOntologyJson, transcriptText, currentDate)
      : buildNewProfilePrompt(speakerName, resolvedSpeakerId, transcriptText, currentDate);

    const geminiResult = await callGeminiGenerateContent(apiKey, model, systemPrompt, userPrompt);
    if (geminiResult.error) {
      return new Response(JSON.stringify({ error: geminiResult.error }), {
        status: geminiResult.status ?? 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const ontology = parseOntologyResponse(geminiResult.rawText, speakerName, resolvedSpeakerId);

    return new Response(JSON.stringify({ profile: JSON.stringify(ontology) }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
