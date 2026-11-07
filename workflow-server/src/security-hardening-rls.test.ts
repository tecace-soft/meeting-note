import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Executes the real hardening migration on an isolated PostgreSQL engine (synthetic fixture).
test('security audit hardening migration (2026-11-07)', { timeout: 30000 }, async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const sql = (path: string) => readFile(new URL('../../' + path, import.meta.url), 'utf8');
  await db.exec(await sql('supabase/tests/security_hardening_fixture_schema.sql'));
  await db.exec(await sql('supabase/migrations/20261107120000_security_audit_hardening.sql'));
  // Idempotent: a second apply must not fail.
  await db.exec(await sql('supabase/migrations/20261107120000_security_audit_hardening.sql'));
  const asUser = async <T>(sub: string, run: () => Promise<T>): Promise<T> => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub })]);
    await db.exec('set role authenticated');
    try { return await run(); } finally { await db.exec('reset role'); }
  };
  const visibleObjects = (sub: string) => asUser(sub, async () =>
    (await db.query<{ name: string }>("select name from storage.objects where bucket_id = 'meeting-note-images' order by name")).rows.map((r) => r.name));

  await t.test('service-only RPCs are not executable by anon or authenticated', async () => {
    for (const fn of ['add_note_to_project_for_user', 'remove_note_from_project_for_user']) {
      const sig = `public.${fn}(text, text, text)`;
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await db.query<{ ok: boolean }>('select has_function_privilege($1, $2, \'execute\') as ok', [role, sig]);
        assert.equal(rows[0].ok, false, `${role} on ${fn}`);
      }
      const { rows } = await db.query<{ ok: boolean }>('select has_function_privilege(\'service_role\', $1, \'execute\') as ok', [sig]);
      assert.equal(rows[0].ok, true, `service_role on ${fn}`);
    }
  });

  await t.test('owner and share recipient still read the images; a forged note_image row grants nothing', async () => {
    const all = ['victim/victim-note/img1-thumb.jpg', 'victim/victim-note/img1.png'];
    assert.deepEqual(await visibleObjects('victim'), all);
    assert.deepEqual(await visibleObjects('reader'), all);
    assert.deepEqual(await visibleObjects('attacker'), []);
  });

  await t.test('note_image rows can only reference the author\'s own folder', async () => {
    await asUser('attacker', async () => {
      await db.query("insert into public.note_image (id, note_id, user_id, storage_path) values ('own', 'attacker-note', 'attacker', 'attacker/attacker-note/ok.png')");
      await assert.rejects(db.query("insert into public.note_image (id, note_id, user_id, storage_path) values ('bad1', 'attacker-note', 'attacker', 'victim/victim-note/img1.png')"), /row-level security/);
      await assert.rejects(db.query("insert into public.note_image (id, note_id, user_id, storage_path, thumbnail_storage_path) values ('bad2', 'attacker-note', 'attacker', 'attacker/attacker-note/a.png', 'victim/victim-note/img1-thumb.jpg')"), /row-level security/);
      await assert.rejects(db.query("update public.note_image set thumbnail_storage_path = 'victim/victim-note/img1-thumb.jpg' where id = 'own'"), /row-level security/);
      await db.query("update public.note_image set thumbnail_storage_path = 'attacker/attacker-note/ok-thumb.jpg' where id = 'own'");
    });
  });

  await t.test('a chat author cannot move a message into a project they cannot access', async () => {
    await asUser('attacker', async () => {
      await assert.rejects(db.query("update public.chat set project_id = 'victim-project' where id = 'attacker-msg'"), /row-level security/);
      const edited = await db.query("update public.chat set message = 'edited' where id = 'attacker-msg' returning id");
      assert.equal(edited.rows.length, 1);
    });
  });
});
