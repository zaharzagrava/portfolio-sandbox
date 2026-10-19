import { waitFor } from '../../utils/async-helpers';

/** The eventual-consistency contract of J01 (spec.md "Eventual-consistency contract"): hop → maximum milliseconds and owner. */
export const HOPS = {
  H1: {
    maxMs: 3_000,
    owner: 'S13',
    what: 'order.reserved → payments order copy',
  },
  H2: {
    maxMs: 5_000,
    owner: 'S13',
    what: 'payment accepted → charge → COMPLETED',
  },
  H2w: {
    maxMs: 13_000,
    owner: 'S13',
    what: 'slow provider (pm_test_slow answers after 8 s) → COMPLETED',
  },
  H3: { maxMs: 5_000, owner: 'S10', what: 'payment_succeeded → order PAID' },
  H3w: { maxMs: 5_000, owner: 'S10', what: 'provider webhook → order PAID' },
  H4: {
    maxMs: 10_000,
    owner: 'S14',
    what: 'order.paid → settlement → seller balance',
  },
  H5: { maxMs: 5_000, owner: 'S28', what: 'order.paid → inbox items' },
  H6: { maxMs: 10_000, owner: 'S16', what: 'events → statement facts' },
  H7: {
    maxMs: 5_000,
    owner: 'S15',
    what: 'run-weekly finished → payout PENDING',
  },
  H8: { maxMs: 15_000, owner: 'S15', what: 'payout PENDING → PAID' },
  H9: {
    maxMs: 5_000,
    owner: 'S28',
    what: 'payout.paid/failed → owner inbox item',
  },
  H10: { maxMs: 30_000, owner: 'S16', what: 'close accepted → period CLOSED' },
  H11: {
    maxMs: 10_000,
    owner: 'S10',
    what: 'payment_failed / hold expiry → order CANCELLED, stock back',
  },
  H12: {
    maxMs: 15_000,
    owner: 'S13',
    what: 'refund_requested → payment REFUNDED',
  },
  H13: { maxMs: 5_000, owner: 'S49', what: 'control-surface job → finished' },
  // J02 (seller to first sale): spec.md "Eventual-consistency contract". Prefixed so they never collide with J01's H1..H13.
  'J02.H1': {
    maxMs: 3_000,
    owner: 'S01',
    what: 'tenancy.shop_created → role becomes SELLER',
  },
  'J02.H2': {
    maxMs: 5_000,
    owner: 'S03',
    what: 'shop.onboarding_submitted → shop PENDING',
  },
  'J02.H3': {
    maxMs: 20_000,
    owner: 'S04',
    what: 'document uploaded → extraction → APPROVED or NEEDS_REVIEW',
  },
  'J02.H4': {
    maxMs: 5_000,
    owner: 'S03',
    what: 'last document approved (or moderator APPROVE) → shop VERIFIED, payoutsEnabled',
  },
  'J02.H5': {
    maxMs: 5_000,
    owner: 'S03',
    what: 'shop.rejected → shop REJECTED, payoutsEnabled false',
  },
  'J02.H6': {
    maxMs: 5_000,
    owner: 'S17',
    what: 'subscription accepted → charge → invoice PAID, subscription ACTIVE',
  },
  'J02.H7': {
    maxMs: 5_000,
    owner: 'S18',
    what: 'billing.subscription_status_changed → entitlements of the new plan',
  },
  'J02.H8': {
    maxMs: 5_000,
    owner: 'S03',
    what: 'billing.subscription_plan_changed → Shop.plan',
  },
  'J02.H9': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'catalog.product_created → search document',
  },
  'J02.H10': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'catalog.product_updated (stock, archive, restore) → search document',
  },
  'J02.H11': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'tenancy.shop_status_changed → products hidden or shown',
  },
  'J02.H12': {
    maxMs: 10_000,
    owner: 'S43',
    what: 'catalog.product_created → webhook product.created first attempt',
  },
  'J02.H13': {
    maxMs: 10_000,
    owner: 'S43',
    what: 'order.paid → webhook order.paid first attempt',
  },
  'J02.H14': {
    maxMs: 5_000, // the deadline (2 x 5 s) is the 10 s floor S40 allows for polling the rank until 200
    owner: 'S40',
    what: 'order.paid → leaderboard board and rank',
  },
  'J02.H15': {
    maxMs: 5_000,
    owner: 'S40',
    what: 'tenancy.shop_created | shop_updated → name and slug on the board',
  },
  'J02.H16': {
    maxMs: 15_000,
    owner: 'S53',
    what: 'consumer resumed or replayed → lag 0',
  },
  'J02.H17': {
    maxMs: 5_000,
    owner: 'S49',
    what: 'job run through the control surface → finished',
  },
  // J03 (launch day): spec.md "Eventual-consistency contract". Prefixed so they never collide with J01's H1..H13.
  'J03.H1': {
    maxMs: 5_000,
    owner: 'S22',
    what: 'job launch-events.open-sales run → event ON_SALE',
  },
  'J03.H2': {
    maxMs: 3_000,
    owner: 'S22',
    what: 'sales open → queued ticket admitted',
  },
  'J03.H3': {
    maxMs: 1_000,
    owner: 'S22',
    what: 'hold or release → seat map change',
  },
  'J03.H4': {
    maxMs: 5_000,
    owner: 'S28',
    what: 'confirm committed → booking.confirmed → booking notice',
  },
  'J03.H5': {
    maxMs: 10_000,
    owner: 'S10',
    what: 'confirm committed → SQS voucher command → voucher issued',
  },
  'J03.H6': {
    maxMs: 1_000,
    owner: 'S22',
    what: 'last seat booked → event SOLD_OUT',
  },
  'J03.H7': {
    maxMs: 5_000,
    owner: 'S22',
    what: 'job expire-hold run → seats free',
  },
  'J03.H8': {
    maxMs: 5_000,
    owner: 'S22',
    what: 'event_sold_out / event_closed relayed',
  },
  'J03.H9': {
    maxMs: 5_000,
    owner: 'S11',
    what: 'job flash-sale.load run → sale LOADED, product stock lowered',
  },
  'J03.H10': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'catalog.product_updated (stock change) → search document',
  },
  'J03.H11': {
    maxMs: 0,
    owner: 'S10',
    what: 'POST /checkout of a drop line → order RESERVED (synchronous)',
  },
  'J03.H12': {
    maxMs: 5_000,
    owner: 'S28',
    what: 'order paid → buyer and shop-owner inbox items',
  },
  'J03.H13': {
    maxMs: 5_000,
    owner: 'S28',
    what: 'flash_sale.sold_out / start_failed → shop-owner notice',
  },
  'J03.H14': {
    maxMs: 10_000,
    owner: 'S11',
    what: 'order CANCELLED (hold expiry) → units back and buyer notice',
  },
  'J03.H15': {
    maxMs: 5_000,
    owner: 'S11',
    what: 'job flash-sale.reconcile run → leftovers returned, sale RECONCILED',
  },
  'J03.H16': {
    maxMs: 5_000,
    owner: 'S23',
    what: 'live.stream_started / _ended relayed',
  },
  'J03.H17': {
    maxMs: 250,
    owner: 'S23',
    what: 'stream start / end, pin, removal → viewers',
  },
  'J03.H18': {
    maxMs: 1_000,
    owner: 'S23',
    what: 'comment accepted → viewers batch',
  },
  'J03.H19': {
    maxMs: 5_000,
    owner: 'S23',
    what: 'comment accepted → history',
  },
  'J03.H20': {
    maxMs: 5_000,
    owner: 'S23',
    what: 'toxic comment accepted → removed',
  },
  'J03.H21': {
    maxMs: 1_000,
    owner: 'S21',
    what: 'bid committed → price push; view',
  },
  'J03.H22': {
    maxMs: 5_000,
    owner: 'S28',
    what: 'auction.leader_changed → outbid notice',
  },
  'J03.H23': {
    maxMs: 5_000,
    owner: 'S21',
    what: 'auction end (job run) → CLOSED / UNSOLD',
  },
  'J03.H24': {
    maxMs: 10_000,
    owner: 'S21',
    what: 'auction.closed → winner order requested → order RESERVED',
  },
  'J03.H25': {
    maxMs: 5_000,
    owner: 'S28',
    what: 'auction.closed → auction.won notice',
  },
  'J03.H26': {
    maxMs: 5_000,
    owner: 'S21',
    what: 'order.paid of the settlement order → auction SOLD → auction.sold notice',
  },
  'J03.H27': {
    maxMs: 10_000,
    owner: 'S21',
    what: 'winner order CANCELLED → SECOND_CHANCE, offer order, notice',
  },
  'J03.H28': {
    maxMs: 10_000,
    owner: 'S21',
    what: 'auction UNSOLD / CANCELLED → unit returned',
  },
  'J03.H29': {
    maxMs: 15_000,
    owner: 'S53',
    what: 'consumer resumed or replayed → lag 0',
  },
  'J03.H30': {
    maxMs: 5_000,
    owner: 'S49',
    what: 'job run through the control surface → finished',
  },
  // J04 (catalog sync to search): spec.md "Eventual-consistency contract". Prefixed so they never collide with J01's H1..H13.
  'J04.H1': {
    maxMs: 30_000,
    owner: 'S07',
    what: 'complete accepted → scan → parse → import DONE',
  },
  'J04.H2': {
    maxMs: 0,
    owner: 'S05',
    what: 'import batch committed → products in the catalog (true at DONE)',
  },
  'J04.H3': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'catalog.product_created | updated → search document',
  },
  'J04.H4': {
    maxMs: 30_000,
    owner: 'S08',
    what: 'OAuth callback → backfill → provider products in the catalog',
  },
  'J04.H5': {
    maxMs: 15_000,
    owner: 'S08',
    what: 'provider webhook accepted → incremental pull → product updated',
  },
  'J04.H6': {
    maxMs: 15_000,
    owner: 'S08',
    what: 'job catalog-sync.sync-all run → pull applied',
  },
  'J04.H7': {
    maxMs: 10_000,
    owner: 'S19',
    what: 'pickup stock written → offer in near-me',
  },
  'J04.H8': {
    maxMs: 10_000,
    owner: 'S19',
    what: 'catalog.product_* (title, price, archive, restore) → near-me product copy',
  },
  'J04.H9': {
    maxMs: 0,
    owner: 'S09',
    what: 'sync push accepted → stock in the catalog (synchronous)',
  },
  'J04.H10': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'catalog.product_updated (quantity) → inStock in the index',
  },
  'J04.H11': {
    maxMs: 10_000,
    owner: 'S08',
    what: 'catalog.product_updated (quantity) → provider stock written',
  },
  'J04.H12': {
    maxMs: 5_000,
    owner: 'S09',
    what: 'catalog.product_updated → other device change feed',
  },
  'J04.H13': {
    maxMs: 15_000,
    owner: 'S08',
    what: 'provider-side stock change → catalog stock merged',
  },
  'J04.H14': {
    maxMs: 10_000,
    owner: 'S32',
    what: 'tenancy.shop_status_changed → products hidden or shown in search and near-me',
  },
  'J04.H15': {
    maxMs: 15_000,
    owner: 'S53',
    what: 'consumer resumed or replayed → lag 0',
  },
  'J04.H16': {
    maxMs: 5_000,
    owner: 'S49',
    what: 'job run through the control surface → finished',
  },
} as const;

export type Hop = keyof typeof HOPS;

/** Multiplier of every deadline: raise it on a loaded machine (README). */
export const TIME_FACTOR = Number(process.env.JOURNEY_TIME_FACTOR ?? '1');

export const POLL_MS = 250;

/** A synchronous or sub-second hop (J03 H11, H17) still gets one second of network, and a poll at 250 ms must be able to see it. */
const MIN_DEADLINE_MS = 1_000;

/** Deadline of a hop: twice the contract maximum, scaled (at least one second). */
export const deadlineMs = (hop: Hop) =>
  Math.max(MIN_DEADLINE_MS, 2 * HOPS[hop].maxMs * TIME_FACTOR);

/**
 * Polls `probe` every 250 ms until it returns a truthy value, up to the hop's deadline. Prints how long the hop took
 * (the raw data behind SC-001, which no single run can prove as a percentile).
 */
export async function waitForContract<T>(
  hop: Hop,
  probe: () => Promise<T | null | undefined | false>,
  what?: string,
): Promise<T> {
  const started = Date.now();
  const value = await waitFor(probe, {
    timeoutMs: deadlineMs(hop),
    intervalMs: POLL_MS,
    description: `${hop} ${what ?? HOPS[hop].what} (owner ${HOPS[hop].owner}, contract ${HOPS[hop].maxMs} ms)`,
  });
  console.log(
    `[hop] ${hop} ${Date.now() - started} ms (contract ${HOPS[hop].maxMs} ms)`,
  );
  return value;
}

/**
 * Asserts, on every poll for the whole deadline of `hop`, that `check` still passes. "Nothing changes" has no event to
 * wait for, so the contract time of the hop is the observation window; the first failing poll fails the test at once.
 */
export async function staysTrue(
  hop: Hop,
  check: () => Promise<void>,
  what: string,
): Promise<void> {
  const until = Date.now() + deadlineMs(hop);
  let failure: unknown;
  await waitFor(
    async () => {
      try {
        await check();
      } catch (error) {
        failure = error;
        return true;
      }
      return Date.now() >= until;
    },
    {
      timeoutMs: deadlineMs(hop) + 5_000,
      intervalMs: POLL_MS,
      description: `${what} stays true for ${deadlineMs(hop)} ms`,
    },
  );
  if (failure) throw failure;
}
