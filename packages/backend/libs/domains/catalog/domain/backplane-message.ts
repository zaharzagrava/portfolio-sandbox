import { z } from 'zod';
import type { BackplaneMessage } from './draft-ports';

const uuid = z.string().uuid();

/** The messages the backplane carries; strict, so a payload with anything else is dropped (S06 contracts/events-services.md). */
export const backplaneMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('revoke'), shopId: uuid, userId: uuid }).strict(),
  z.object({ type: z.literal('recheck'), shopId: uuid, userId: uuid }).strict(),
  z
    .object({
      type: z.literal('close-shop'),
      shopId: uuid,
      reason: z.literal('shop_inactive'),
    })
    .strict(),
  z
    .object({
      type: z.literal('close-draft'),
      draftId: uuid,
      reason: z.literal('draft_closed'),
    })
    .strict(),
]);

/** Parses a raw channel payload; anything that is not exactly one of the messages is `null`. */
export function parseBackplaneMessage(raw: string): BackplaneMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = backplaneMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
