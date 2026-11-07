import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { noteAccessFilterFor } from './supabase.js';

// A client whose every query fails, so the filter keeps only the two direct-access branches.
const failingClient = {
  from: () => ({ select: () => ({ contains: () => ({ limit: async () => ({ data: null, error: { message: 'offline' } }) }) }) }),
} as unknown as SupabaseClient;

test('note access scope: no user is unscoped, a malformed user id fails closed', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await noteAccessFilterFor(failingClient, undefined), null);
  for (const bad of ['a.b', 'x,user_id.neq.0', 'a)b', 'a b']) {
    await assert.rejects(noteAccessFilterFor(failingClient, bad), { message: 'Invalid user id for note access scope.' }, bad);
  }
  const id = '7f4c1a2e-0000-4000-8000-000000000001';
  assert.equal(await noteAccessFilterFor(failingClient, id), `user_id.eq.${id},shared_users.cs.{${id}}`);
});
