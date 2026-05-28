import {
  applySpeakerReplacements,
  getTranscriptAvatarLabel,
  normalizeTranscript,
  type TranscriptSegment,
} from '../src/lib/transcriptSegments';
import {
  deriveSelfSpeakerNameFromMsDisplayName,
  findBestSpeakerRowForMsAccount,
  normalizeNameForIdentityMatch,
} from '../src/lib/matchSpeakerIdentity';
import {
  buildSpeakerContextForSummary,
  canonicalOntologyProfileString,
  clampConfidence01,
  parseOntology,
} from '../src/lib/speakerOntology';

type TestFn = () => void | Promise<void>;

const tests: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}. Expected ${e}, got ${a}`);
}

test('normalizeTranscript supports arrays, wrapped arrays, JSON strings, and plain text fallback', () => {
  assertDeepEqual(
    normalizeTranscript([{ speaker: 'Speaker 1', text: 'Hello' }]),
    [{ speaker: 'Speaker 1', text: 'Hello' }],
    'array diarization should normalize'
  );

  assertDeepEqual(
    normalizeTranscript({ segments: [{ speakerName: 'Gene', content: 'Update' }] }),
    [{ speaker: 'Gene', text: 'Update' }],
    'wrapped diarization should normalize'
  );

  assertDeepEqual(
    normalizeTranscript(JSON.stringify([{ Speaker: 'A', Text: 'B' }])),
    [{ speaker: 'A', text: 'B' }],
    'JSON string diarization should normalize'
  );

  assertDeepEqual(
    normalizeTranscript('Plain transcript'),
    [{ speaker: 'Transcript', text: 'Plain transcript' }],
    'plain text should become a transcript segment'
  );
});

test('applySpeakerReplacements honors single, from_here, and all scopes', () => {
  const segments: TranscriptSegment[] = [
    { speaker: 'Speaker 1', text: 'a' },
    { speaker: 'Speaker 2', text: 'b' },
    { speaker: 'Speaker 1', text: 'c' },
  ];

  assertDeepEqual(
    applySpeakerReplacements(segments, 0, 'Speaker 1', 'Gene Kim', 'single').map((s) => s.speaker),
    ['Gene Kim', 'Speaker 2', 'Speaker 1'],
    'single replacement should only affect selected segment'
  );

  assertDeepEqual(
    applySpeakerReplacements(segments, 0, 'Speaker 1', 'Gene Kim', 'from_here').map((s) => s.speaker),
    ['Gene Kim', 'Speaker 2', 'Gene Kim'],
    'from_here replacement should affect matching later segments'
  );

  assertDeepEqual(
    applySpeakerReplacements(segments, 2, 'Speaker 1', 'Gene Kim', 'all').map((s) => s.speaker),
    ['Gene Kim', 'Speaker 2', 'Gene Kim'],
    'all replacement should affect all matching segments'
  );
});

test('speaker identity matching normalizes Microsoft names and prefers strongest row', () => {
  assertEqual(normalizeNameForIdentityMatch('Gene Kim (김진)'), 'gene kim', 'name normalization should strip parenthetical/non-Latin text');
  assertEqual(deriveSelfSpeakerNameFromMsDisplayName('GENE KIM (김진)'), 'Gene Kim', 'derived self speaker name should be title-cased');

  const match = findBestSpeakerRowForMsAccount(
    [{ name: 'Gene' }, { name: 'Gene Kim' }, { name: 'Someone Else' }],
    'Gene Kim (김진)'
  );
  assertEqual(match?.name, 'Gene Kim', 'self speaker matching should prefer full normalized match');
});

test('avatar labels stay compact for numbered speakers and names', () => {
  assertEqual(getTranscriptAvatarLabel('Speaker 12'), '12', 'numbered speaker label should use speaker number');
  assertEqual(getTranscriptAvatarLabel('Gene Kim'), 'GK', 'two-word names should use initials');
  assertEqual(getTranscriptAvatarLabel('A'), 'A', 'single short names should still render');
});

test('speaker ontology parsing canonicalizes JSON and builds summary context', () => {
  assertEqual(clampConfidence01(2), 1, 'confidence should clamp high values');
  assertEqual(clampConfidence01(-1), 0, 'confidence should clamp low values');

  const raw = JSON.stringify({
    schema_version: '1.0',
    speaker_id: 'sp_1',
    display_name: 'Gene Kim',
    aliases: ['Gene'],
    identity_confidence: 0.8,
    professional_context: { company: 'TecAce', role: 'Engineer', domains: ['AI'], confidence: 0.9 },
    active_projects: [{ name: 'Meeting Note', role_in_project: 'Owner', status: 'active', importance: 'high', confidence: 1 }],
    responsibilities: [{ description: 'Owns meeting notes', scope: 'Product', related_projects: ['Meeting Note'], status: 'active', confidence: 0.9 }],
    relationships: [],
    open_threads: [{ topic: 'MCP rollout', status: 'open', priority: 'high', summary: 'Ship connector', related_projects: ['Meeting Note'], confidence: 0.7 }],
    deprecated_field: 'remove me',
  });

  const parsed = parseOntology(raw);
  assert(parsed, 'ontology should parse');
  assertEqual(parsed.display_name, 'Gene Kim', 'ontology display name should survive parsing');

  const canonical = canonicalOntologyProfileString(raw);
  assert(!canonical.includes('deprecated_field'), 'canonical ontology should drop unknown fields');

  const context = buildSpeakerContextForSummary('Fallback', raw);
  assert(context.includes('Speaker: Gene Kim'), 'summary context should include speaker');
  assert(context.includes('Role: Engineer'), 'summary context should include role');
  assert(context.includes('Open topics: MCP rollout'), 'summary context should include open topics');
});

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      process.stderr.write(`FAIL ${name}\n  ${message}\n`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} QA test${failures.length === 1 ? '' : 's'} failed.\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${tests.length} QA tests passed.\n`);
}

void main();
