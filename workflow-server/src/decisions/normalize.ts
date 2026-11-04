// F2: name normalization. Resolves people / orgs / projects in an extraction to canonical
// entities using (1) the seed alias list from the handoff and (2) the owner's existing
// mn_entities rows. Unknown names are kept as-is (never guessed) and logged as alias
// candidates, together with any "alias 후보: A → B" hints the model wrote in quality_notes.
//
// Names are display data only. Nothing here is used for authorization (see AGENTS.md
// "Identity trust").

export type EntityType = 'person' | 'org' | 'project';

export interface EntityDef {
  type: EntityType;
  canonical: string;
  aliases: string[];
  attrs?: Record<string, string>;
}

// Seed list, verbatim from the handoff Prompt A alias block. Keep in sync with prompt.ts.
// "강성원(Samsung) ≠ 강사장(TecAce)" is enforced by keeping them as two separate entities with
// no shared alias.
// Assumption: Niffler is typed 'project' (the handoff does not say what it is).
export const SEED_ENTITIES: EntityDef[] = [
  { type: 'project', canonical: 'Niffler', aliases: ['Ripler', 'Nippler', 'Repler'] },
  { type: 'person', canonical: 'Gene Kim', aliases: ['Gene', '김진', 'Gene Kim(김진)'], attrs: { korean_name: '김진' } },
  { type: 'person', canonical: 'Andrew Yoo', aliases: ['Andrew', '유영준', 'Andrew Yoo(유영준)'], attrs: { korean_name: '유영준' } },
  { type: 'person', canonical: '김융', aliases: ['Yung'] },
  { type: 'person', canonical: '하스티브', aliases: ['Steve Ha'] },
  { type: 'person', canonical: '김창희', aliases: ['Charlie Kim'] },
  { type: 'person', canonical: '김교탁', aliases: ['Kotak', 'Kyotak', '교탁', '김교탁(Samsung)'], attrs: { org: 'Samsung' } },
  { type: 'person', canonical: '김성훈', aliases: ['김상훈', '김성원(회계사)', '김성훈(SHK CPA)'], attrs: { org: 'SHK CPA' } },
  { type: 'person', canonical: '강성원', aliases: ['강성원(Samsung)'], attrs: { org: 'Samsung' } },
  { type: 'person', canonical: '강사장', aliases: ['강사장(TecAce)'], attrs: { org: 'TecAce' } },
];

export interface AliasCandidate {
  type: EntityType | 'unknown';
  raw: string;
  suggested?: string;
  source: 'unknown_name' | 'quality_notes';
}

const SPEAKER_LABEL = /^(speaker|화자)\s*[a-z0-9]+$/i;
const ESTIMATED = /\s*\(추정\)\s*$/;

function key(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** "Speaker B" / "화자 1" style diarization labels are never entities. */
export function isSpeakerLabel(name: string): boolean {
  return SPEAKER_LABEL.test(name.replace(ESTIMATED, '').trim());
}

export class EntityResolver {
  private byKey = new Map<string, EntityDef>();
  readonly candidates: AliasCandidate[] = [];
  private seenCandidates = new Set<string>();

  constructor(defs: EntityDef[] = SEED_ENTITIES) {
    for (const def of defs) this.add(def);
  }

  add(def: EntityDef): void {
    for (const name of [def.canonical, ...def.aliases]) {
      const k = `${def.type}|${key(name)}`;
      if (!this.byKey.has(k)) this.byKey.set(k, def);
    }
  }

  /**
   * Resolve a raw name to its canonical form. "(추정)" is preserved on the output so a guessed
   * attribution stays visibly a guess. Speaker labels and unknown names are returned unchanged;
   * unknown ones are recorded as alias candidates.
   */
  resolve(type: EntityType, raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const estimated = ESTIMATED.test(trimmed);
    const base = trimmed.replace(ESTIMATED, '').trim();
    if (isSpeakerLabel(base)) return trimmed;
    const def = this.lookup(type, base);
    if (def) return estimated ? `${def.canonical} (추정)` : def.canonical;
    this.recordUnknown(type, base);
    return trimmed;
  }

  /** Canonical entity for a name, or undefined. Tries the full string, then without a "(...)" suffix. */
  lookup(type: EntityType, name: string): EntityDef | undefined {
    const direct = this.byKey.get(`${type}|${key(name)}`);
    if (direct) return direct;
    const withoutParen = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (withoutParen && withoutParen !== name) return this.byKey.get(`${type}|${key(withoutParen)}`);
    return undefined;
  }

  private recordUnknown(type: EntityType, raw: string): void {
    const k = `${type}|${key(raw)}`;
    if (this.seenCandidates.has(k)) return;
    this.seenCandidates.add(k);
    this.candidates.push({ type, raw, source: 'unknown_name' });
  }

  /** Pull "alias 후보: A → B" (also "->", "=>") hints out of quality_notes. */
  collectQualityNoteHints(qualityNotes: string | null | undefined): void {
    if (!qualityNotes) return;
    const re = /alias\s*후보\s*[:：]\s*([^→\->=\n;,]+?)\s*(?:→|->|=>)\s*([^\n;,]+)/gi;
    for (const m of qualityNotes.matchAll(re)) {
      const raw = m[1].trim();
      const suggested = m[2].trim().replace(/[.。]$/, '');
      const k = `hint|${key(raw)}|${key(suggested)}`;
      if (!raw || !suggested || this.seenCandidates.has(k)) continue;
      this.seenCandidates.add(k);
      this.candidates.push({ type: 'unknown', raw, suggested, source: 'quality_notes' });
    }
  }
}

/** Build a resolver from the seed list plus the owner's stored entities. */
export function resolverFromStored(rows: Array<{ type: string; canonical_name: string; aliases: string[] | null; attrs?: unknown }>): EntityResolver {
  const resolver = new EntityResolver(SEED_ENTITIES);
  for (const row of rows) {
    if (row.type !== 'person' && row.type !== 'org' && row.type !== 'project') continue;
    resolver.add({ type: row.type, canonical: row.canonical_name, aliases: row.aliases ?? [] });
  }
  return resolver;
}
