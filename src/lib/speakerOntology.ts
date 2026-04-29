export interface SpeakerOntology {
  schema_version: string;
  speaker_id: string;
  display_name: string;
  aliases: string[];
  identity_confidence: number;
  summary_for_meeting_context: string;
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

export function isOntologyProfile(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = raw.trim();
  return t.startsWith('{') || t.startsWith('[');
}

export function parseOntology(raw: string | null | undefined): SpeakerOntology | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(stripped) as SpeakerOntology;
  } catch {
    return null;
  }
}

/**
 * Build a compact context string for meeting summary prompts from a stored profile.
 * Handles both ontology JSON and legacy markdown.
 */
export function buildSpeakerContextForSummary(name: string, rawProfile: string | null | undefined): string {
  if (!rawProfile?.trim()) return '';
  if (!isOntologyProfile(rawProfile)) {
    // Legacy markdown — use as-is
    return `Speaker: ${name}\n${rawProfile.trim()}`;
  }
  const o = parseOntology(rawProfile);
  if (!o) return '';
  const lines: string[] = [`Speaker: ${o.display_name || name}`];
  if (o.professional_context?.role) lines.push(`Role: ${o.professional_context.role}`);
  if (o.professional_context?.company) lines.push(`Company: ${o.professional_context.company}`);
  if (o.summary_for_meeting_context) lines.push(`Context: ${o.summary_for_meeting_context}`);
  if (o.active_projects?.length) {
    lines.push(`Active projects: ${o.active_projects.map((p) => p.name).filter(Boolean).join(', ')}`);
  }
  if (o.responsibilities?.length) {
    lines.push(`Responsibilities: ${o.responsibilities.map((r) => r.description).filter(Boolean).join('; ')}`);
  }
  if (o.relationships?.length) {
    lines.push(`Relationships: ${o.relationships.map((r) => `${r.relationship_type} with ${r.person_or_group}`).join(', ')}`);
  }
  if (o.open_threads?.length) {
    const open = o.open_threads.filter((t) => t.status !== 'resolved');
    if (open.length) lines.push(`Open topics: ${open.map((t) => t.topic).join('; ')}`);
  }
  return lines.join('\n');
}
