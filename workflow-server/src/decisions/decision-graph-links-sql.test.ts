import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// M2 linking function on the production migrations: ownership, ordering and confidence checks,
// invalid_at recompute (bi-temporal: never deleted), idempotency, and preservation of human links.
test('mn_apply_decision_links validates, links, and recomputes invalid_at', { timeout: 60000 }, async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const sql = (path: string) => readFile(new URL('../../../' + path, import.meta.url), 'utf8');
  await db.exec(await sql('supabase/tests/note_rls_fixture_schema.sql'));
  await db.exec(await sql('supabase/migrations/20260602124000_enable_user_data_rls.sql'));
  await db.exec(await sql('supabase/migrations/20260630123000_fix_project_sharing_rpcs.sql'));
  await db.exec(await sql('supabase/migrations/20261104120000_create_decision_graph.sql'));
  await db.exec(await sql('supabase/migrations/20261105120000_decision_graph_read_functions.sql'));
  await db.exec(await sql('supabase/migrations/20261106120000_decision_graph_linking.sql'));
  await db.exec('grant select, insert, update, delete on public.note, public.project to service_role');
  await db.exec("insert into public.note (id, user_id, name) values ('old-note', 'note-owner', 'Old'), ('new-note', 'note-owner', 'New'), ('foreign', 'someone-else', 'F')");

  const svc = async <T>(run: () => Promise<T>) => {
    await db.exec('set role service_role');
    try { return await run(); } finally { await db.exec('reset role'); }
  };
  const seed = (note: string, user: string, prefix: string, date: string) => svc(() => db.query('select public.mn_replace_note_extraction($1, $2, $3::jsonb)', [note, user, JSON.stringify({
    id_prefix: prefix, run_id: null, prompt_version: 'v',
    record: { meeting_date: date, title: note, meeting_kind: 'internal', purpose: null, sensitivity: 'normal', quality: 'ok', quality_notes: null, duplicate_of: null, references_to_past: [] },
    entities: [], actions: [], issues: [],
    decisions: [{ local_id: 'D-1', text: `${note} decision`, status: 'decided', side: 'tecace', decided_by: null, participants: [], why: null, trigger: null, alternatives_rejected: [], assumptions: [], effective_date: null, project: 'P', evidence_quote: 'q', evidence_segment_ids: [], evidence_match: true }],
  })]));
  await seed('old-note', 'note-owner', '261001-old', '2026-10-01');
  await seed('new-note', 'note-owner', '261101-new', '2026-11-01');
  await seed('foreign', 'someone-else', '261001-for', '2026-10-01');
  const OLD = 'D:261001-old-01';
  const NEW = 'D:261101-new-01';
  const FOREIGN = 'D:261001-for-01';
  const apply = (links: unknown[], note = 'new-note', user = 'note-owner') => svc(() => db.query<{ r: { inserted: number; rejected: number; superseded: number } }>('select public.mn_apply_decision_links($1, $2, $3, $4::jsonb) as r', [user, note, 'link-v1', JSON.stringify(links)]));
  const invalidAt = async (id: string) => (await svc(() => db.query<{ v: string | null }>('select invalid_at::text as v from public.mn_decisions where id = $1', [id]))).rows[0].v;
  const linkCount = async () => Number((await svc(() => db.query<{ c: string }>('select count(*) as c from public.mn_decision_links'))).rows[0].c);

  await t.test('valid supersedes link sets the old decision invalid_at to the new valid_from; record marked linked', async () => {
    const { rows } = await apply([{ new: NEW, old: OLD, rel: 'supersedes', confidence: 0.9, reason: '번복' }]);
    assert.deepEqual(rows[0].r, { inserted: 1, rejected: 0, superseded: 1 });
    assert.equal(await invalidAt(OLD), '2026-11-01');
    const rec = (await svc(() => db.query<{ linked_version: string }>("select linked_version from public.mn_meeting_records where note_id = 'new-note'"))).rows[0];
    assert.equal(rec.linked_version, 'link-v1');
  });

  await t.test('re-applying the same links is idempotent', async () => {
    await apply([{ new: NEW, old: OLD, rel: 'supersedes', confidence: 0.9, reason: '번복' }]);
    assert.equal(await linkCount(), 1);
    assert.equal(await invalidAt(OLD), '2026-11-01');
  });

  await t.test('invalid links are rejected: foreign owner, later old, low confidence, wrong note, bad rel', async () => {
    const { rows } = await apply([
      { new: NEW, old: FOREIGN, rel: 'refines', confidence: 0.9 },
      { new: OLD, old: NEW, rel: 'refines', confidence: 0.9 },
      { new: NEW, old: OLD, rel: 'confirms', confidence: 0.5 },
      { new: NEW, old: OLD, rel: 'none', confidence: 0.9 },
      { new: NEW, old: NEW, rel: 'refines', confidence: 0.9 },
    ]);
    assert.deepEqual(rows[0].r, { inserted: 0, rejected: 5, superseded: 0 });
    // The earlier supersedes link (LLM, unreviewed) was replaced by this empty-valid set, so the old decision is valid again.
    assert.equal(await linkCount(), 0);
    assert.equal(await invalidAt(OLD), null);
  });

  await t.test('human or reviewed links survive re-linking and keep invalid_at', async () => {
    await svc(() => db.exec(`insert into public.mn_decision_links (new_decision, old_decision, rel, confidence, source, reviewed) values ('${NEW}', '${OLD}', 'supersedes', 1, 'human', true)`));
    await apply([]);
    assert.equal(await linkCount(), 1);
    await apply([{ new: NEW, old: OLD, rel: 'refines', confidence: 0.8 }]);
    assert.equal(await linkCount(), 2);
    assert.equal(await invalidAt(OLD), '2026-11-01');
  });

  await t.test('ownership and grants', async () => {
    await assert.rejects(apply([], 'new-note', 'someone-else'), /no meeting record owned/);
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: 'note-owner' })]);
    await db.exec('set role authenticated');
    try {
      await assert.rejects(db.query("select public.mn_apply_decision_links('note-owner', 'new-note', 'v', '[]'::jsonb)"), /permission denied/);
    } finally { await db.exec('reset role'); }
  });
});
