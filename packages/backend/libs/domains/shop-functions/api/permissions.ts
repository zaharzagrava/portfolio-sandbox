import type { ShopPermission } from '@app/domains/tenancy';

/**
 * The permission every route of this capability requires (S45 FR-001). S03 is asked to define `functions.manage` for
 * OWNER and ADMIN; until it does, `shop.manage` has the same role set (research D-12), so switching is this one line.
 */
export const FUNCTIONS_PERMISSION: ShopPermission = 'shop.manage';
