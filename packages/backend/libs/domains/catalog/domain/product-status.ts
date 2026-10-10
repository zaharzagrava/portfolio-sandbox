import { assertNever } from '@app/common/core/assert-never';

export const PRODUCT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_TRANSITIONS = ['archive', 'restore'] as const;
export type ProductTransition = (typeof PRODUCT_TRANSITIONS)[number];

export type StatusMove =
  { ok: true; to: ProductStatus } | { ok: false; code: 'invalid_transition' };

const ok = (to: ProductStatus): StatusMove => ({ ok: true, to });
const illegal: StatusMove = { ok: false, code: 'invalid_transition' };

/** The product status machine (AS-21): `ACTIVE --archive--> ARCHIVED --restore--> ACTIVE`; everything else is illegal. */
export function applyTransition(
  from: ProductStatus,
  transition: ProductTransition,
): StatusMove {
  switch (from) {
    case 'ACTIVE':
      return transition === 'archive' ? ok('ARCHIVED') : illegal;
    case 'ARCHIVED':
      return transition === 'restore' ? ok('ACTIVE') : illegal;
    default:
      return assertNever(from);
  }
}
