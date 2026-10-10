import { assertNever } from '@app/common/core/assert-never';

export const SHOP_STATUSES = [
  'ACTIVE',
  'SUSPENDED',
  'DELETING',
  'DELETED',
] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];

export type StatusMove =
  { ok: true; to: ShopStatus } | { ok: false; code: 'invalid_transition' };

const ok = (to: ShopStatus): StatusMove => ({ ok: true, to });
const illegal: StatusMove = { ok: false, code: 'invalid_transition' };

/** The shop status machine (AS-64): ACTIVE<->SUSPENDED, ACTIVE|SUSPENDED->DELETING, DELETING->ACTIVE|DELETED. */
export function nextState(from: ShopStatus, to: ShopStatus): StatusMove {
  switch (from) {
    case 'ACTIVE':
      return to === 'SUSPENDED' || to === 'DELETING' ? ok(to) : illegal;
    case 'SUSPENDED':
      return to === 'ACTIVE' || to === 'DELETING' ? ok(to) : illegal;
    case 'DELETING':
      return to === 'ACTIVE' || to === 'DELETED' ? ok(to) : illegal;
    case 'DELETED':
      return illegal;
    default:
      return assertNever(from);
  }
}
