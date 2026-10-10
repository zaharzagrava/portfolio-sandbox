import type { ShopRole } from './shop-types';

/** Roles an actor may touch or hand out (FR-021): OWNER everything, ADMIN only STAFF and VIEWER, others nothing. */
const MANAGEABLE: Record<ShopRole, readonly ShopRole[]> = {
  OWNER: ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'],
  ADMIN: ['STAFF', 'VIEWER'],
  STAFF: [],
  VIEWER: [],
};

/**
 * May `actor` act on a member who currently holds `target` (and, for a role change, move them to `next`)?
 * Privilege never rises through a lower role: an ADMIN cannot create owners or admins, nor touch them.
 */
export function canManage(
  actor: ShopRole,
  target: ShopRole,
  next?: ShopRole,
): boolean {
  const allowed = MANAGEABLE[actor];
  return (
    allowed.includes(target) && (next === undefined || allowed.includes(next))
  );
}

/** Leaving is always the member's own right; the last-owner rule is enforced by the service. */
export function canLeave(_role: ShopRole): boolean {
  return true;
}
