/** Owner-scoped repository methods must never run without an owner id (a dropped filter would widen the write). */
export function requireOwnerId(userId: unknown): string {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Owner id is required for an owner-scoped query.');
  }
  return userId;
}
