import { z } from 'zod';

/**
 * Payload contracts of the S53 test-only `fixtures` aggregate (`libs/infrastructure/events/testing`).
 * `fixtures.item_renamed` has two contract versions to exercise the upcast chain.
 */
export const fixtureItemChangedV1Schema = z.object({ name: z.string().min(1) });
export const fixtureItemRenamedV1Schema = z.object({ name: z.string().min(1) });
export const fixtureItemRenamedV2Schema = z.object({
  title: z.string().min(1),
});
/** An event with no state change of its own (`appendStandalone`). */
export const fixtureReindexCompletedV1Schema = z.object({
  count: z.number().int().min(0),
});
/** A delta event: a quantity change (never allowed on a `latest-per-key` topic). */
export const fixtureCounterBumpedV1Schema = z.object({
  by: z.number().int(),
});
