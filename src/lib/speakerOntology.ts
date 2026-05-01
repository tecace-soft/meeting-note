export interface SpeakerOntology {
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

/** Canonical ontology — drops deprecated/extra keys (e.g. summary_for_meeting_context). */
export function normalizeOntologyLoose(parsed: unknown): SpeakerOntology | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const pcRaw = p.professional_context;
  const pc =
    pcRaw && typeof pcRaw === 'object' && !Array.isArray(pcRaw)
      ? (pcRaw as Record<string, unknown>)
      : {};

  return {
    schema_version: typeof p.schema_version === 'string' ? p.schema_version : '1.0',
    speaker_id: typeof p.speaker_id === 'string' ? p.speaker_id : '',
    display_name: typeof p.display_name === 'string' ? p.display_name : '',
    aliases: Array.isArray(p.aliases) ? p.aliases.filter((x): x is string => typeof x === 'string') : [],
    identity_confidence: typeof p.identity_confidence === 'number' ? p.identity_confidence : 0,
    professional_context: {
      company: typeof pc.company === 'string' ? pc.company : '',
      role: typeof pc.role === 'string' ? pc.role : '',
      domains: Array.isArray(pc.domains) ? pc.domains.filter((x): x is string => typeof x === 'string') : [],
    },
    active_projects: Array.isArray(p.active_projects) ? (p.active_projects as SpeakerOntology['active_projects']) : [],
    relationships: Array.isArray(p.relationships) ? (p.relationships as SpeakerOntology['relationships']) : [],
    responsibilities: Array.isArray(p.responsibilities) ? (p.responsibilities as SpeakerOntology['responsibilities']) : [],
    open_threads: Array.isArray(p.open_threads) ? (p.open_threads as SpeakerOntology['open_threads']) : [],
    evidence: Array.isArray(p.evidence) ? (p.evidence as SpeakerOntology['evidence']) : [],
    last_updated_at: typeof p.last_updated_at === 'string' ? p.last_updated_at : new Date().toISOString(),
  };
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
    return normalizeOntologyLoose(JSON.parse(stripped));
  } catch {
    return null;
  }
}

/** Persists ontology JSON without deprecated keys; returns legacy/markdown unchanged. */
export function canonicalOntologyProfileString(raw: string): string {
  const t = raw.trim();
  if (!isOntologyProfile(t)) return raw;
  const o = parseOntology(t);
  if (!o) return raw;
  return JSON.stringify(o, null, 2);
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
