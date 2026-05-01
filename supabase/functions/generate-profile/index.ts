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
  apiKey?: string;
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
  };
  active_projects: {
    name: string;
    role_in_project: string;
    status: string;
    importance: string;
  }[];
  relationships: {
    person_or_group: string;
    relationship_type: string;
    context: string;
    related_projects: string[];
  }[];
  responsibilities: {
    description: string;
    scope: string;
    related_projects: string[];
    status: string;
  }[];
  open_threads: {
    topic: string;
    status: string;
    priority: string;
    summary: string;
    related_projects: string[];
  }[];
  evidence: {
    source: string;
    quote_or_paraphrase: string;
    supports: string[];
  }[];
  last_updated_at: string;
}

function fallbackOntology(speakerName: string, speakerId: string): SpeakerOntology {
  return {
    schema_version: '1.0',
    speaker_id: speakerId,
    display_name: speakerName,
    aliases: [],
    identity_confidence: 0,
    professional_context: { company: '', role: '', domains: [] },
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
          },
        ]
      : [],
  };
}

function parseOntologyResponse(raw: string, speakerName: string, speakerId: string): SpeakerOntology {
  // Strip any accidental markdown code fences
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as SpeakerOntology;
    // Ensure required fields exist
    return {
      schema_version: parsed.schema_version ?? '1.0',
      speaker_id: parsed.speaker_id || speakerId,
      display_name: parsed.display_name || speakerName,
      aliases: parsed.aliases ?? [],
      identity_confidence: typeof parsed.identity_confidence === 'number' ? parsed.identity_confidence : 0,
      professional_context: {
        company: parsed.professional_context?.company ?? '',
        role: parsed.professional_context?.role ?? '',
        domains: parsed.professional_context?.domains ?? [],
      },
      active_projects: parsed.active_projects ?? [],
      relationships: parsed.relationships ?? [],
      responsibilities: parsed.responsibilities ?? [],
      open_threads: parsed.open_threads ?? [],
      evidence: parsed.evidence ?? [],
      last_updated_at: parsed.last_updated_at || new Date().toISOString(),
    };
  } catch (e) {
    console.error('Failed to parse ontology JSON. Raw output:', raw, 'Error:', e);
    return fallbackOntology(speakerName, speakerId);
  }
}

const NEW_PROFILE_SYSTEM = `You are a speaker ontology extraction engine for a meeting note application.

Your job is to create a practical, lightweight speaker memory ontology from a diarized meeting transcript.

The goal is not to create a perfect academic ontology. The goal is to create structured speaker context that helps future meeting summaries become more accurate, relevant, and consistent.`;

const UPDATE_PROFILE_SYSTEM = `You are a speaker ontology update engine for a meeting note application.

Your job is to update an existing lightweight speaker memory ontology using a new diarized meeting transcript.

The goal is to preserve useful speaker context while adding new professional information that improves future meeting summaries.`;

function buildNewProfilePrompt(name: string, speakerId: string, transcript: string, currentDate: string): string {
  return `Create a new speaker ontology for ${name} using the meeting transcript below.

Rules:
- Use only information that is explicitly stated or strongly supported by the transcript.
- Do not invent personal details, titles, companies, relationships, or responsibilities.
- Prefer useful business/professional context over personality analysis.
- Avoid storing sensitive personal information.
- If a field is unknown, use an empty string, empty array, or low confidence.
- Keep the ontology compact and useful for future meeting summarization.
- Output valid JSON only. Do not output markdown.

Required JSON structure:
{
  "schema_version": "1.0",
  "speaker_id": "${speakerId}",
  "display_name": "${name}",
  "aliases": [],
  "identity_confidence": 0.0,
  "professional_context": {
    "company": "",
    "role": "",
    "domains": []
  },
  "active_projects": [
    {
      "name": "",
      "role_in_project": "",
      "status": "active | paused | completed | unknown",
      "importance": "high | medium | low | unknown"
    }
  ],
  "relationships": [
    {
      "person_or_group": "",
      "relationship_type": "collaborator | customer | manager | team_member | vendor | stakeholder | unknown",
      "context": "",
      "related_projects": []
    }
  ],
  "responsibilities": [
    {
      "description": "",
      "scope": "general | project-specific | meeting-specific",
      "related_projects": [],
      "status": "active | completed | unknown"
    }
  ],
  "open_threads": [
    {
      "topic": "",
      "status": "open | waiting | resolved | unknown",
      "priority": "high | medium | low | unknown",
      "summary": "",
      "related_projects": []
    }
  ],
  "evidence": [
    {
      "source": "transcript",
      "quote_or_paraphrase": "",
      "supports": []
    }
  ],
  "last_updated_at": "${currentDate}"
}

Transcript:
${transcript}`;
}

function buildUpdateProfilePrompt(name: string, existingOntologyJson: string, transcript: string, currentDate: string): string {
  return `Update the existing ontology for ${name} using the new transcript below.

Rules:
- Keep existing information unless the new transcript clearly updates or corrects it.
- Prefer newer transcript information when there is a direct conflict.
- Do not duplicate projects, relationships, responsibilities, or open threads.
- Merge similar items instead of creating near-duplicates.
- Use only information that is explicitly stated or strongly supported.
- Do not add sensitive personal information.
- Keep the ontology compact and useful for future meeting summarization.
- Output valid JSON only. Do not output markdown.

Merge behavior:
- If the same project appears again, update its role, status, or importance only if the new transcript adds useful information.
- If the same relationship appears again, enrich the context instead of duplicating it.
- If a responsibility is repeated, keep one clear version.
- If an open thread is resolved, change its status to "resolved".
- If a new unresolved topic appears, add it to open_threads.
- Add short evidence entries only for important new or changed facts.
- Update last_updated_at to "${currentDate}".

Required JSON structure:
{
  "schema_version": "1.0",
  "speaker_id": "",
  "display_name": "",
  "aliases": [],
  "identity_confidence": 0.0,
  "professional_context": { "company": "", "role": "", "domains": [] },
  "active_projects": [],
  "relationships": [],
  "responsibilities": [],
  "open_threads": [],
  "evidence": [],
  "last_updated_at": "${currentDate}"
}

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

    const apiKey = Deno.env.get('OPENAI_API_KEY') || bodyApiKey || '';
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No OpenAI API key available.' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
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
        existingOntologyJson = existingProfile.trim();
      }
    }

    const systemPrompt = existingOntologyJson ? UPDATE_PROFILE_SYSTEM : NEW_PROFILE_SYSTEM;
    const userPrompt = existingOntologyJson
      ? buildUpdateProfilePrompt(speakerName, existingOntologyJson, transcriptText, currentDate)
      : buildNewProfilePrompt(speakerName, resolvedSpeakerId, transcriptText, currentDate);

    const openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!openAiRes.ok) {
      const errText = await openAiRes.text();
      return new Response(JSON.stringify({ error: `OpenAI error: ${errText}` }), {
        status: openAiRes.status, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await openAiRes.json() as { choices?: { message?: { content?: string } }[] };
    const rawContent = aiData.choices?.[0]?.message?.content?.trim() ?? '';
    const ontology = parseOntologyResponse(rawContent, speakerName, resolvedSpeakerId);

    return new Response(JSON.stringify({ profile: JSON.stringify(ontology) }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
