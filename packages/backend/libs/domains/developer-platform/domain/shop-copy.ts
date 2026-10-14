export type ShopCopyDecision = 'apply' | 'ignore';

/**
 * The version guard of the shop copy kept on a site (FR-033, AS-42): a greater `shopVersion` applies, an equal or lower
 * one is a duplicate or arrived out of order and changes nothing. A value that is not a safe integer is never applied.
 */
export function decideShopCopy(
  storedVersion: number,
  incomingVersion: number,
): ShopCopyDecision {
  return Number.isSafeInteger(incomingVersion) &&
    incomingVersion > storedVersion
    ? 'apply'
    : 'ignore';
}

/** A site works only while its shop is `ACTIVE` (FR-028), whatever its own switch says. */
export const isShopActive = (status: string): boolean => status === 'ACTIVE';
