import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// M1 read functions (service_role, used by the MCP tools) must return exactly what RLS lets each
// user see. Runs the production migrations on an isolated engine.
test('decision graph read functions match RLS visibility and apply filters', { timeout: 60000 }, async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const sql = (path: string) => readFile(new URL('../../../' + path, import.meta.url), 'utf8');
  await db.exec(await sql('supabase/tests/note_rls_fixture_schema.sql'));
  await db.exec(await sql('supabase/migrations/20260602124000_enable_user_data_rls.sql'));
  await db.exec(await sql('supabase/migrations/20260630123000_fix_project_sharing_rpcs.sql'));
  await db.exec(await sql('supabase/migrations/20261104120000_create_decision_graph.sql'));
  await db.exec(await sql('supabase/migrations/20261105120000_decision_graph_read_functions.sql'));
  await db.exec("update public.project set shared_users = array['project-reader'] where id = 'owned-project'");
  await db.exec('grant select, insert, update, delete on public.note, public.project to service_role');
  await db.exec("insert into public.note (id, user_id, name, shared_users) values ('secret-note', 'note-owner', 'Pricing', array['direct-reader'])");
  await db.exec("insert into public.note (id, user_id, name) values ('other-note', 'someone-else', 'Other')");

  const as = async <T>(role: 'authenticated' | 'service_role', sub: string, run: () => Promise<T>): Promise<T> => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub })]);
    await db.exec(`set role ${role}`);
    try { return await run(); } finally { await db.exec('reset role'); }
  };
  const svc = <T>(run: () => Promise<T>) => as('service_role', '', run);
  const payload = (prefix: string, sensitivity: string, decisions: Array<Record<string, unknown>>) => JSON.stringify({
    id_prefix: prefix, run_id: null, prompt_version: 'v',
    record: { meeting_date: '2026-11-04', title: `T ${prefix}`, meeting_kind: 'internal', purpose: null, sensitivity, quality: 'ok', quality_notes: null, duplicate_of: null, references_to_past: [] },
    entities: [{ type: 'project', canonical_name: 'Niffler', aliases: ['Repler', '리플러'], attrs: {}, role: 'about_project' }],
    decisions, actions: [{ text: 'act', owner: '이한수', due: null, from_decision: 'D-1', evidence_quote: null, evidence_segment_ids: [], evidence_match: null }], issues: [],
  });
  const dec = (i: number, status: string, extra: Record<string, unknown> = {}) => ({
    local_id: `D-${i}`, text: `decision ${i} about billing`, status, side: 'tecace', decided_by: '이한수', participants: ['한창환'], why: 'cost', trigger: null,
    alternatives_rejected: [], assumptions: [], effective_date: null, project: 'Niffler', evidence_quote: 'q', evidence_segment_ids: ['s0'], evidence_match: true, ...extra,
  });
  await svc(() => db.query('select public.mn_replace_note_extraction($1, $2, $3::jsonb)', ['fixture-note', 'note-owner', payload('261104-fixtur', 'normal', [dec(1, 'decided'), dec(2, 'proposed'), dec(3, 'direction', { decided_by: '김교탁', project: 'Other' })])]));
  await svc(() => db.query('select public.mn_replace_note_extraction($1, $2, $3::jsonb)', ['secret-note', 'note-owner', payload('261104-secret', 'financial', [dec(1, 'decided')])]));
  await svc(() => db.query('select public.mn_replace_note_extraction($1, $2, $3::jsonb)', ['other-note', 'someone-else', payload('261104-othern', 'normal', [dec(1, 'decided')])]));

  const users = ['note-owner', 'direct-reader', 'project-reader', 'unrelated', 'someone-else', ''];

  await t.test('mn_user_can_view_note equals the note RLS policy for every user and note', async () => {
    for (const sub of users) {
      const rls = (await as('authenticated', sub, () => db.query<{ id: string }>('select id from public.note order by id'))).rows.map((r) => r.id);
      const fn = (await svc(() => db.query<{ id: string }>('select id from public.note where public.mn_user_can_view_note($1, id) order by id', [sub]))).rows.map((r) => r.id);
      assert.deepEqual(fn, rls, `user ${sub || '(empty)'}`);
    }
  });

  await t.test('mn_visible_decisions equals RLS-visible decisions (incl. sensitivity) for every user', async () => {
    for (const sub of users) {
      const rls = (await as('authenticated', sub, () => db.query<{ id: string }>('select id from public.mn_decisions order by id'))).rows.map((r) => r.id);
      const fn = (await svc(() => db.query<{ id: string }>('select id from public.mn_visible_decisions($1, p_limit => 50) order by id', [sub]))).rows.map((r) => r.id);
      assert.deepEqual(fn, rls, `user ${sub || '(empty)'}`);
    }
    // Spot-check the sensitive rule: direct-reader sees the secret note but not its decisions.
    const reader = (await svc(() => db.query<{ id: string }>("select id from public.mn_visible_decisions('direct-reader', p_limit => 50)"))).rows.map((r) => r.id);
    assert.ok(!reader.some((id) => id.includes('secret')));
  });

  await t.test('filters: status, person, project alias, query, ids, limit clamp, total_count', async () => {
    const q = async (args: string, params: unknown[] = []) => (await svc(() => db.query<{ id: string; total_count: string }>(`select id, total_count from public.mn_visible_decisions('note-owner'${args}) order by id`, params))).rows;
    assert.deepEqual((await q(", p_statuses => array['decided']")).map((r) => r.id), ['D:261104-fixtur-01', 'D:261104-secret-01']);
    assert.deepEqual((await q(", p_person => '%교탁%'")).map((r) => r.id), ['D:261104-fixtur-03']);
    assert.deepEqual((await q(", p_person => '%창환%', p_note_ids => array['fixture-note']")).length, 3);
    assert.deepEqual((await q(", p_project => '%repler%'")).map((r) => r.id), ['D:261104-fixtur-01', 'D:261104-fixtur-02', 'D:261104-secret-01']);
    assert.deepEqual((await q(", p_query => '%decision 2%'")).map((r) => r.id), ['D:261104-fixtur-02']);
    assert.deepEqual((await q(", p_decision_ids => array['D:261104-othern-01']")), []);
    const limited = await q(', p_limit => 1');
    assert.equal(limited.length, 1);
    assert.equal(Number(limited[0].total_count), 4);
    assert.equal((await q(', p_limit => 999')).length, 4);
  });

  await t.test('superseded decisions are hidden unless asked for', async () => {
    await svc(() => db.exec("update public.mn_decisions set invalid_at = '2026-11-05' where id = 'D:261104-fixtur-02'"));
    const ids = async (inc: boolean) => (await svc(() => db.query<{ id: string }>("select id from public.mn_visible_decisions('note-owner', p_note_ids => array['fixture-note'], p_include_superseded => $1)", [inc]))).rows.length;
    assert.equal(await ids(false), 2);
    assert.equal(await ids(true), 3);
  });

  await t.test('actions, links and coverage respect visibility', async () => {
    const actions = async (sub: string) => (await svc(() => db.query<{ id: string }>('select id from public.mn_visible_actions($1)', [sub]))).rows.map((r) => r.id).sort();
    assert.deepEqual(await actions('note-owner'), ['A:261104-fixtur-01', 'A:261104-secret-01']);
    assert.deepEqual(await actions('direct-reader'), ['A:261104-fixtur-01']);
    assert.deepEqual(await actions('unrelated'), []);
    await svc(() => db.exec("insert into public.mn_decision_links (new_decision, old_decision, rel) values ('D:261104-fixtur-01', 'D:261104-secret-01', 'refines')"));
    const links = async (sub: string) => (await svc(() => db.query('select * from public.mn_visible_links($1, array[\'D:261104-fixtur-01\'])', [sub]))).rows.length;
    assert.equal(await links('note-owner'), 1);
    assert.equal(await links('direct-reader'), 0);
    const cov = async (sub: string) => Number((await svc(() => db.query<{ c: string }>('select public.mn_visible_record_count($1) as c', [sub]))).rows[0].c);
    assert.deepEqual([await cov('note-owner'), await cov('direct-reader'), await cov('project-reader'), await cov('unrelated')], [2, 1, 1, 0]);
  });

  await t.test('clients cannot call the read functions', () => as('authenticated', 'note-owner', async () => {
    await assert.rejects(db.query("select * from public.mn_visible_decisions('note-owner')"), /permission denied/);
    await assert.rejects(db.query("select public.mn_user_can_view_note('note-owner', 'fixture-note')"), /permission denied/);
  }));
});
