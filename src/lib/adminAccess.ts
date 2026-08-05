export const ADMIN_MICROSOFT_USER_IDS = [
  'd84c9149-2261-4ced-b14c-01b1a377ba6b', // Hansoo Lee (hansoo@tecace.com)
  'd9eb0f3d-819e-4b45-8df6-e9f229de2447', // Gene Kim (genekim@tecace.com)
  '31d79bfe-2488-47c2-aa45-949375e93bde', // Andrew Yoo (andrewyoo@tecace.com)
] as const;

export const TRANSCRIPTION_MODEL_TEST_USER_ID = 'd9eb0f3d-819e-4b45-8df6-e9f229de2447';

export function isAdminMicrosoftUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ADMIN_MICROSOFT_USER_IDS.includes(userId as (typeof ADMIN_MICROSOFT_USER_IDS)[number]);
}

export function canAccessTranscriptionModelTest(userId: string | null | undefined): boolean {
  return userId === TRANSCRIPTION_MODEL_TEST_USER_ID;
}
