import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestBody {
  speakerName: string;
  transcriptText: string;
  existingProfile?: string | null;
  apiKey?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const body = (await req.json()) as RequestBody;
    const { speakerName, transcriptText, existingProfile, apiKey: bodyApiKey } = body;

    // Prefer the Supabase secret; fall back to key passed in the request body.
    const apiKey = Deno.env.get('OPENAI_API_KEY') || bodyApiKey || '';
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No OpenAI API key available. Set OPENAI_API_KEY as a Supabase secret.' }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (!speakerName || !transcriptText) {
      return new Response(JSON.stringify({ error: 'speakerName and transcriptText are required.' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const systemPrompt = existingProfile
      ? 'You are a professional profile writer. You update and enhance existing speaker profiles using new meeting transcript data.'
      : 'You are a professional profile writer. You create detailed speaker profiles from meeting transcripts.';

    const userPrompt = existingProfile
      ? `Update the profile for "${speakerName}" using the new meeting transcript below.

Rules:
- Retain all information from the existing profile.
- Add new information found in the transcript.
- If anything in the transcript conflicts with the existing profile, prefer the new information.
- Cover role, company, relationships with other speakers, project roles, goals, assignments, expertise, and any other inferable detail.
- Output clean, well-structured markdown.

Existing profile:
${existingProfile}

Meeting transcript:
${transcriptText}

Updated profile for ${speakerName}:`
      : `Generate a comprehensive professional profile for the speaker named "${speakerName}" based on the meeting transcript below.

Include everything that can possibly be inferred:
- Role/title and company
- Relationships with other speakers
- Roles in any projects discussed
- Goals, priorities, and assignments
- Areas of expertise
- Communication style and personality
- Any other relevant professional context

Output clean, well-structured markdown.

Meeting transcript:
${transcriptText}

Profile for ${speakerName}:`;

    const openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });

    if (!openAiRes.ok) {
      const errText = await openAiRes.text();
      return new Response(JSON.stringify({ error: `OpenAI error: ${errText}` }), {
        status: openAiRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const data = await openAiRes.json() as { choices?: { message?: { content?: string } }[] };
    const profile = data.choices?.[0]?.message?.content?.trim() ?? '';

    return new Response(JSON.stringify({ profile }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
