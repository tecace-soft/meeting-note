import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Execute the production policy SQL, not a reimplementation of the predicates.
test('note RLS contracts on an isolated PostgreSQL engine', { timeout: 30000 }, async (t) => {
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
  for (const concurrent of ['revoke', 'add'] as const) {
    await t.test(`conditional share ${concurrent} race preserves the other tab's change`, { timeout: 3000 }, () => asUser('note-owner', async () => {
      await db.exec("update public.note set shared_users = array['A','keep'] where id = 'fixture-note'");
      const before = (await db.query<{ shared_users: string[] }>("select shared_users from public.note where id = 'fixture-note'")).rows[0].shared_users;
      const current = concurrent === 'revoke' ? ['keep'] : ['A', 'keep', 'other-tab'];
      const literal = (ids: string[]) => '{' + ids.map((id) => JSON.stringify(id)).join(',') + '}';
      // The second tab commits after the first tab's read and before its conditional UPDATE.
      await db.query("update public.note set shared_users = $1::text[] where id = 'fixture-note'", [literal(current)]);
      const stale = await db.query("update public.note set shared_users = $1::text[] where id = 'fixture-note' and user_id = 'note-owner' and shared_users = $2::text[] returning id", [literal([...before, 'chosen']), literal(before)]);
      assert.deepEqual(stale.rows, [], 'a stale snapshot must never overwrite a concurrent share change');
      const refreshed = (await db.query<{ shared_users: string[] }>("select shared_users from public.note where id = 'fixture-note'")).rows[0].shared_users;
      assert.deepEqual(refreshed, current, 'the other tab change survives the rejected UPDATE');
      const retry = await db.query("update public.note set shared_users = $1::text[] where id = 'fixture-note' and user_id = 'note-owner' and shared_users = $2::text[] returning id", [literal([...refreshed, 'chosen']), literal(refreshed)]);
      assert.deepEqual(retry.rows, [{ id: 'fixture-note' }], 'the fresh snapshot permits exactly one owner write');
      assert.deepEqual((await db.query("select shared_users from public.note where id = 'fixture-note'")).rows, [{ shared_users: [...current, 'chosen'] }]);
    }));
  }
  await t.test('NULL and empty sharing lists are distinct conditional snapshots', { timeout: 3000 }, () => asUser('note-owner', async () => {
    await db.exec("update public.note set shared_users = '{}' where id = 'fixture-note'");
    const staleNull = await db.query("update public.note set shared_users = array['chosen'] where id = 'fixture-note' and user_id = 'note-owner' and shared_users is null returning id");
    assert.deepEqual(staleNull.rows, [], 'NULL must not match an empty array');
    await db.exec("update public.note set shared_users = null where id = 'fixture-note'");
    const staleEmpty = await db.query("update public.note set shared_users = array['chosen'] where id = 'fixture-note' and user_id = 'note-owner' and shared_users = '{}'::text[] returning id");
    assert.deepEqual(staleEmpty.rows, [], 'an empty array must not match NULL');
    const freshNull = await db.query("update public.note set shared_users = array['chosen'] where id = 'fixture-note' and user_id = 'note-owner' and shared_users is null returning id");
    assert.deepEqual(freshNull.rows, [{ id: 'fixture-note' }]);
  }));
  await t.test('non-owner cannot update shares even with a current snapshot and an owner filter', { timeout: 3000 }, async () => {
    await asUser('note-owner', async () => {
      await db.exec("update public.note set shared_users = array['direct-reader'] where id = 'fixture-note'");
    });
    await asUser('direct-reader', async () => {
      const write = await db.query("update public.note set shared_users = array['unauthorized'] where id = 'fixture-note' and user_id = 'note-owner' and shared_users = array['direct-reader'] returning id");
      assert.deepEqual(write.rows, [], 'the owner predicate is not a substitute for the RLS check');
    });
    await asUser('note-owner', async () => {
      assert.deepEqual((await db.query("select shared_users from public.note where id = 'fixture-note'")).rows, [{ shared_users: ['direct-reader'] }]);
    });
  });

  await t.test('PostgreSQL parses escaped text-array snapshots with NULL and empty members exactly', { timeout: 3000 }, async () => {
    const literal = String.raw`{"quote\"member","path\\member","NULL",NULL,"","comma,member","brace}member"}`;
    const result = await db.query('select $1::text[] as snapshot', [literal]);
    assert.deepEqual(result.rows, [{ snapshot: ['quote"member', 'path\\member', 'NULL', null, '', 'comma,member', 'brace}member'] }], 'snapshot text[] encoding must round-trip all members');
  });

});
