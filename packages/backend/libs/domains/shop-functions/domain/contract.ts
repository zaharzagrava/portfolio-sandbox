import { z } from 'zod';

/** What seller code receives: one shop's cart lines (never other shops' lines, never customer PII). */
export interface FunctionInput {
  currency: string;
  lines: {
    productId: string;
    category: string;
    quantity: number;
    unitPrice: number;
  }[];
}

/**
 * What seller code may return - validated, never trusted (01/02 §8). The host
 * then CLAMPS: a line can't go below 0, so a buggy "200% off" is harmless.
 */
export const FunctionOutput = z.object({
  discounts: z
    .array(
      z.object({
        lineIndex: z.number().int().min(0),
        type: z.enum(['percentage', 'fixedPerUnit']),
        value: z.number().positive().max(1_000_000),
        message: z.string().max(80),
      }),
    )
    .max(50),
});
export type FunctionOutput = z.infer<typeof FunctionOutput>;

/** Applies validated discounts → new unit prices (minor units, never negative, percentages capped at 100). */
export function applyDiscounts(
  lines: FunctionInput['lines'],
  output: FunctionOutput,
): number[] {
  const prices = lines.map((l) => l.unitPrice);
  for (const d of output.discounts) {
    if (d.lineIndex >= prices.length) continue;
    const cut =
      d.type === 'percentage'
        ? Math.floor(
            (lines[d.lineIndex].unitPrice * Math.min(d.value, 100)) / 100,
          )
        : Math.floor(d.value);
    prices[d.lineIndex] = Math.max(0, prices[d.lineIndex] - cut);
  }
  return prices;
}
