// Regression: a query issued before auth settles must not run as anon just because the
// AuthProvider's first effect run CLEARS the provider (user not set yet). Prod bug
// 2026-10-15: /issues mounted, its reads were queued, the provider was set to null, the
// queued reads resolved with no token and went out as anon (401 / empty list).
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSupabaseAccessTokenForRequest,
  setSupabaseAccessTokenProvider,
  setSupabaseAuthResolvedWithoutUser,
} from './supabaseConfig';

const settled = async <T,>(p: Promise<T>): Promise<{ done: boolean; value?: T }> => {
  let state: { done: boolean; value?: T } = { done: false };
  void p.then((value) => {
    state = { done: true, value };
  });
  await new Promise((r) => setTimeout(r, 0));
  return state;
};

afterEach(() => {
  setSupabaseAccessTokenProvider(null);
  setSupabaseAuthResolvedWithoutUser(false);
});

describe('supabase access token for a queued request', () => {
  it('keeps waiting when the provider is cleared, and uses the provider registered next', async () => {
    const pending = getSupabaseAccessTokenForRequest();
    setSupabaseAccessTokenProvider(null); // AuthProvider effect with user still null
    expect((await settled(pending)).done).toBe(false);
    setSupabaseAccessTokenProvider(async () => 'user-jwt');
    expect(await pending).toBe('user-jwt');
  });

  it('proceeds without a token only when auth settled logged-out', async () => {
    const pending = getSupabaseAccessTokenForRequest();
    setSupabaseAccessTokenProvider(null);
    setSupabaseAuthResolvedWithoutUser(true);
    expect(await pending).toBeNull();
  });
});
