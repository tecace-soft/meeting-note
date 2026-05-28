export const ADMIN_MICROSOFT_USER_IDS = [
  'd84c9149-2261-4ced-b14c-01b1a377ba6b',
  'd9eb0f3d-819e-4b45-8df6-e9f229de2447',
] as const;

export function isAdminMicrosoftUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ADMIN_MICROSOFT_USER_IDS.includes(userId as (typeof ADMIN_MICROSOFT_USER_IDS)[number]);
}
