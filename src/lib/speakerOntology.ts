/** Model confidence in inferred facts for this block (0.0–1.0). */
export function clampConfidence01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

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

/** Canonical ontology — drops deprecated/extra keys (e.g. summary_for_meeting_context). */
export function normalizeOntologyLoose(parsed: unknown): SpeakerOntology | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const pcRaw = p.professional_context;
  const pcObj =
    pcRaw && typeof pcRaw === 'object' && !Array.isArray(pcRaw)
      ? mapProfessionalContext(pcRaw as Record<string, unknown>)
      : mapProfessionalContext({});

  return {
    schema_version: typeof p.schema_version === 'string' ? p.schema_version : '1.0',
    speaker_id: typeof p.speaker_id === 'string' ? p.speaker_id : '',
    display_name: typeof p.display_name === 'string' ? p.display_name : '',
    aliases: Array.isArray(p.aliases) ? p.aliases.filter((x): x is string => typeof x === 'string') : [],
    identity_confidence: typeof p.identity_confidence === 'number' ? p.identity_confidence : 0,
    professional_context: pcObj,
    active_projects: mapObjectArray(p.active_projects, mapActiveProject),
    relationships: mapObjectArray(p.relationships, mapRelationship),
    responsibilities: mapObjectArray(p.responsibilities, mapResponsibility),
    open_threads: mapObjectArray(p.open_threads, mapOpenThread),
    evidence: mapObjectArray(p.evidence, mapEvidence),
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
