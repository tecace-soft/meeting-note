import { describe, expect, it } from 'vitest';
import {
  ADMIN_MICROSOFT_USER_IDS,
  TRANSCRIPTION_MODEL_TEST_USER_ID,
  isAdminMicrosoftUser,
} from './adminAccess';

describe('isAdminMicrosoftUser', () => {
  it('keeps exactly two admins and accepts each listed id', () => {
    expect(ADMIN_MICROSOFT_USER_IDS).toHaveLength(2);
    expect(new Set(ADMIN_MICROSOFT_USER_IDS).size).toBe(2);
    for (const id of ADMIN_MICROSOFT_USER_IDS) {
      expect(isAdminMicrosoftUser(id)).toBe(true);
    }
  });

  it('rejects unknown, empty and missing ids', () => {
    expect(isAdminMicrosoftUser('bbbbbbbb-0000-4000-8000-000000000002')).toBe(false);
    expect(isAdminMicrosoftUser('')).toBe(false);
    expect(isAdminMicrosoftUser(null)).toBe(false);
    expect(isAdminMicrosoftUser(undefined)).toBe(false);
  });

  it('does not grant admin through the transcription test user id (departed admin removed)', () => {
    expect(isAdminMicrosoftUser(TRANSCRIPTION_MODEL_TEST_USER_ID)).toBe(false);
  });
});
