import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Executes the production migration SQL (not a reimplementation) on an isolated engine, on top
// of the same note RLS fixture the note RLS contract test uses.
test('decision graph SQL: RLS inheritance, sensitivity, idempotent replace, human_verified protection', { timeout: 60000 }, async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const sql = (path: string) => readFile(new URL('../../../' + path, import.meta.url), 'utf8');
  await db.exec(await sql('supabase/tests/note_rls_fixture_schema.sql'));
  await db.exec(await sql('supabase/migrations/20260602124000_enable_user_data_rls.sql'));
  await db.exec(await sql('supabase/migrations/20260630123000_fix_project_sharing_rpcs.sql'));
  await db.exec(await sql('supabase/migrations/20261104120000_create_decision_graph.sql'));
  await db.exec("update public.project set shared_users = array['project-reader'] where id = 'owned-project'");
  // Hosted Supabase grants service_role on every public table by default; the fixture does not.
  await db.exec('grant select, insert, update, delete on public.note, public.project to service_role');
  await db.exec("insert into public.note (id, user_id, name, shared_users) values ('secret-note', 'note-owner', 'Pricing', array['direct-reader'])");
  await db.exec("insert into public.note (id, user_id, name) values ('other-note', 'someone-else', 'Other')");

  const as = async <T>(role: 'authenticated' | 'service_role', sub: string, run: () => Promise<T>): Promise<T> => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub })]);
    await db.exec(`set role ${role}`);
    try { return await run(); } finally { await db.exec('reset role'); }
  };
  const replace = (noteId: string, userId: string, payload: unknown) =>
    as('service_role', '', () => db.query<{ r: Record<string, number> }>('select public.mn_replace_note_extraction($1, $2, $3::jsonb) as r', [noteId, userId, JSON.stringify(payload)]));

  const payload = (sensitivity = 'normal', decisions = 2) => ({
    id_prefix: '261104-fixtur',
    run_id: null,
    prompt_version: 'decision-extract-v1',
    record: { meeting_date: '2026-11-04', title: 'Fixture', meeting_kind: 'internal', purpose: 'p', sensitivity, quality: 'ok', quality_notes: null, duplicate_of: null, references_to_past: [] },
    entities: [
      { type: 'person', canonical_name: 'Andrew Yoo', aliases: ['Andrew'], attrs: {}, role: 'participant' },
      { type: 'project', canonical_name: 'Meeting Note', aliases: [], attrs: {}, role: 'about_project' },
    ],
    decisions: Array.from({ length: decisions }, (_, i) => ({
      local_id: `D-${i + 1}`, text: `decision ${i + 1}`, status: i === 0 ? 'decided' : 'proposed', side: 'tecace',
      decided_by: 'Andrew Yoo', participants: ['Andrew Yoo'], why: null, trigger: null, alternatives_rejected: [], assumptions: [],
      effective_date: null, project: 'Meeting Note', evidence_quote: 'quote', evidence_segment_ids: ['s0'], evidence_match: true,
    })),
    actions: [{ text: 'do it', owner: 'Andrew Yoo', due: null, from_decision: 'D-1', evidence_quote: 'summary', evidence_segment_ids: [], evidence_match: null }],
    issues: [{ text: 'risk', type: 'risk', raised_by: null, evidence_quote: null, evidence_segment_ids: [], evidence_match: null }],
  });

  await t.test('first replace writes record, entities, decisions, actions, issues', async () => {
    const { rows } = await replace('fixture-note', 'note-owner', payload());
    assert.deepEqual(rows[0].r, { decisions: 2, actions: 1, issues: 1, preserved_verified_decisions: 0 });
    const d = await as('service_role', '', () => db.query<{ id: string; project_entity_id: string | null; valid_from: string }>('select id, project_entity_id, valid_from::text from public.mn_decisions order by seq'));
    assert.deepEqual(d.rows.map((r) => r.id), ['D:261104-fixtur-01', 'D:261104-fixtur-02']);
    assert.ok(d.rows[0].project_entity_id, 'project resolved to entity id');
    assert.equal(d.rows[0].valid_from, '2026-11-04');
    const a = await as('service_role', '', () => db.query<{ from_decision: string }>('select from_decision from public.mn_actions'));
    assert.equal(a.rows[0].from_decision, 'D:261104-fixtur-01');
  });

  await t.test('re-running the same payload is idempotent (same ids, no duplicates)', async () => {
    await replace('fixture-note', 'note-owner', payload());
    const counts = await as('service_role', '', () => db.query<{ d: number; a: number; i: number; e: number; me: number }>(
      "select (select count(*)::int from mn_decisions) d, (select count(*)::int from mn_actions) a, (select count(*)::int from mn_issues) i, (select count(*)::int from mn_entities) e, (select count(*)::int from mn_meeting_entities) me"));
    assert.deepEqual(counts.rows[0], { d: 2, a: 1, i: 1, e: 2, me: 2 });
  });

  for (const sub of ['note-owner', 'direct-reader', 'project-reader']) {
    await t.test(`${sub} reads the record and its decisions (inherits note visibility)`, () => as('authenticated', sub, async () => {
      assert.equal((await db.query('select note_id from public.mn_meeting_records')).rows.length, 1);
      assert.equal((await db.query('select id from public.mn_decisions')).rows.length, 2);
      assert.equal((await db.query('select id from public.mn_actions')).rows.length, 1);
    }));
  }

  await t.test('unrelated and missing-subject callers read nothing', async () => {
    for (const sub of ['unrelated', '']) await as('authenticated', sub, async () => {
      for (const table of ['mn_meeting_records', 'mn_decisions', 'mn_actions', 'mn_issues', 'mn_meeting_entities', 'mn_entities', 'mn_extraction_runs']) {
        assert.deepEqual((await db.query(`select 1 from public.${table}`)).rows, [], `${sub || 'missing'}:${table}`);
      }
    });
  });

  await t.test('sensitive meetings are visible to the note owner only', async () => {
    await replace('secret-note', 'note-owner', { ...payload('customer-commercial', 1), id_prefix: '261104-secret' });
    await as('authenticated', 'direct-reader', async () => {
      // direct-reader can read the note itself, but not its sensitive decision data.
      assert.equal((await db.query("select id from public.note where id = 'secret-note'")).rows.length, 1);
      assert.deepEqual((await db.query("select 1 from public.mn_meeting_records where note_id = 'secret-note'")).rows, []);
      assert.deepEqual((await db.query("select 1 from public.mn_decisions where note_id = 'secret-note'")).rows, []);
    });
    await as('authenticated', 'note-owner', async () => {
      assert.equal((await db.query("select 1 from public.mn_decisions where note_id = 'secret-note'")).rows.length, 1);
    });
  });

  await t.test('clients cannot write or call the replace function', () => as('authenticated', 'note-owner', async () => {
    await assert.rejects(db.query("update public.mn_decisions set status = 'decided'"), /permission denied/);
    await assert.rejects(db.query("delete from public.mn_decisions"), /permission denied/);
    await assert.rejects(db.query("select public.mn_replace_note_extraction('fixture-note', 'note-owner', '{}'::jsonb)"), /permission denied/);
  }));

  await t.test('replace refuses a note the user does not own', async () => {
    await assert.rejects(replace('other-note', 'note-owner', payload()), /not owned/);
  });

  await t.test('human_verified decisions and records survive re-extraction; new rows are numbered after them', async () => {
    await as('service_role', '', async () => {
      await db.exec("update public.mn_decisions set human_verified = true, text = 'edited by human', status = 'direction' where id = 'D:261104-fixtur-02'");
      await db.exec("update public.mn_meeting_records set human_verified = true, title = 'Human title' where note_id = 'fixture-note'");
    });
    const { rows } = await replace('fixture-note', 'note-owner', { ...payload('normal', 3), record: { ...payload().record, title: 'Model title' } });
    assert.equal(rows[0].r.preserved_verified_decisions, 1);
    const d = await as('service_role', '', () => db.query<{ id: string; text: string; status: string; human_verified: boolean }>(
      "select id, text, status, human_verified from public.mn_decisions where note_id = 'fixture-note' order by seq"));
    assert.deepEqual(d.rows.map((r) => [r.id, r.text, r.status, r.human_verified]), [
      ['D:261104-fixtur-02', 'edited by human', 'direction', true],
      ['D:261104-fixtur-03', 'decision 1', 'decided', false],
      ['D:261104-fixtur-04', 'decision 2', 'proposed', false],
      ['D:261104-fixtur-05', 'decision 3', 'proposed', false],
    ]);
    const a = await as('service_role', '', () => db.query<{ from_decision: string }>("select from_decision from public.mn_actions where note_id = 'fixture-note'"));
    assert.deepEqual(a.rows, [{ from_decision: 'D:261104-fixtur-03' }]);
    const rec = await as('service_role', '', () => db.query<{ title: string }>("select title from public.mn_meeting_records where note_id = 'fixture-note'"));
    assert.equal(rec.rows[0].title, 'Human title');
  });

  await t.test('links are visible only when both decisions are visible', async () => {
    await as('service_role', '', () => db.exec(
      "insert into public.mn_decision_links (new_decision, old_decision, rel, confidence) values ('D:261104-fixtur-03', 'D:261104-secret-01', 'refines', 0.9)"));
    await as('authenticated', 'note-owner', async () => assert.equal((await db.query('select 1 from public.mn_decision_links')).rows.length, 1));
    await as('authenticated', 'direct-reader', async () => assert.deepEqual((await db.query('select 1 from public.mn_decision_links')).rows, []));
  });

  await t.test('deleting the note cascades all decision data', async () => {
    await as('service_role', '', () => db.exec("delete from public.note where id = 'fixture-note'"));
    const c = await as('service_role', '', () => db.query<{ n: number }>(
      "select (select count(*) from mn_decisions where note_id = 'fixture-note') + (select count(*) from mn_actions where note_id = 'fixture-note') + (select count(*) from mn_meeting_records where note_id = 'fixture-note') as n"));
    assert.equal(Number(c.rows[0].n), 0);
  });
});
