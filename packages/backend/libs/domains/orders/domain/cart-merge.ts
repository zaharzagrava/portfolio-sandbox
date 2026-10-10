export interface CartLine {
  productId: string;
  quantity: number;
  addedAt: string;
}

export interface MergeLimits {
  maxLines: number;
  maxQuantity: number;
}

export const DEFAULT_MERGE_LIMITS: MergeLimits = {
  maxLines: 50,
  maxQuantity: 20,
};

/**
 * Guest cart → user cart (S10 FR-008, AS-12). A product appears once with `min(max, user + guest)`; the user's lines
 * all survive and keep their `addedAt`; guest-only lines follow, oldest first (ties by product id), until the cart
 * holds `maxLines`; the rest are dropped and counted.
 */
export function mergeCarts(
  user: CartLine[],
  guest: CartLine[],
  limits: MergeLimits = DEFAULT_MERGE_LIMITS,
): { lines: CartLine[]; droppedLines: number } {
  const guestById = new Map(guest.map((l) => [l.productId, l]));
  const lines: CartLine[] = user.map((l) => {
    const g = guestById.get(l.productId);
    return g
      ? {
          ...l,
          quantity: Math.min(limits.maxQuantity, l.quantity + g.quantity),
        }
      : { ...l };
  });
  const userIds = new Set(user.map((l) => l.productId));
  const incoming = guest
    .filter((l) => !userIds.has(l.productId))
    .sort(
      (a, b) =>
        a.addedAt.localeCompare(b.addedAt) ||
        a.productId.localeCompare(b.productId),
    );
  let dropped = 0;
  for (const l of incoming) {
    if (lines.length < limits.maxLines)
      lines.push({ ...l, quantity: Math.min(limits.maxQuantity, l.quantity) });
    else dropped += 1;
  }
  return { lines, droppedLines: dropped };
}
