import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Execute the production policy SQL, not a reimplementation of the predicates.
test('note RLS contracts on an isolated PostgreSQL engine', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const sql = (path: string) => readFile(new URL('../../' + path, import.meta.url), 'utf8');
  await db.exec(await sql('supabase/tests/note_rls_fixture_schema.sql'));
  await db.exec(await sql('supabase/migrations/20260602124000_enable_user_data_rls.sql'));
  await db.exec(await sql('supabase/migrations/20260630123000_fix_project_sharing_rpcs.sql'));
  await db.exec("update public.project set shared_users = array['project-reader'] where id = 'owned-project'");
  const asUser = async (sub: string, run: () => Promise<void>) => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub })]);
    await db.exec('set role authenticated');
    try { await run(); } finally { await db.exec('reset role'); }
  };
  await t.test('fixture really executes as a non-owner role without RLS bypass', async () => asUser('note-owner', async () => {
    const { rows } = await db.query<{ current_user: string; rolbypassrls: boolean }>('select current_user, rolbypassrls from pg_roles where rolname = current_user');
    assert.deepEqual(rows, [{ current_user: 'authenticated', rolbypassrls: false }]);
  }));
  for (const sub of ['note-owner', 'direct-reader', 'project-reader']) {
    await t.test(`${sub} retains read access`, () => asUser(sub, async () => {
      assert.deepEqual((await db.query('select id from public.note')).rows, [{ id: 'fixture-note' }]);
    }));
  }
  for (const sub of ['direct-reader', 'project-reader', 'unrelated', '']) {
    for (const field of ['name', 'summary_edit']) await t.test(`${sub || 'missing subject'} ${field} UPDATE returns zero rows without an SQL error`, () => asUser(sub, async () => {
      const result = await db.query(`update public.note set ${field} = 'Unauthorized edit' where id = 'fixture-note' returning id`);
      assert.equal(result.affectedRows, 0);
      assert.deepEqual(result.rows, []);
    }));
  }
  await t.test('unrelated and missing-subject reads are empty', async () => {
    for (const sub of ['unrelated', '']) await asUser(sub, async () => {
      assert.deepEqual((await db.query('select id from public.note')).rows, []);
    });
  });
  await t.test('denied updates did not change either field', () => asUser('note-owner', async () => {
    assert.deepEqual((await db.query('select name, summary_edit from public.note')).rows, [{ name: 'Original title', summary_edit: 'Original summary' }]);
  }));
  for (const field of ['name', 'summary_edit']) await t.test(`owner ${field} UPDATE returns exactly one id`, () => asUser('note-owner', async () => {
    const result = await db.query(`update public.note set ${field} = 'Owner edit' where id = 'fixture-note' and user_id = 'note-owner' returning id`);
    assert.equal(result.affectedRows, 1);
    assert.deepEqual(result.rows, [{ id: 'fixture-note' }]);
  }));
  await t.test('WITH CHECK prevents changing the note owner', () => asUser('note-owner', async () => {
    await assert.rejects(db.query("update public.note set user_id = 'direct-reader' where id = 'fixture-note'"), /row-level security/);
  }));
});
