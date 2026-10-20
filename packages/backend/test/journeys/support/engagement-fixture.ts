import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  experimentResultsSchema,
  experimentSchema,
  feedPageSchema,
  followStatusSchema,
  linkConversionPageSchema,
  linkStatsSchema,
  postViewSchema,
  shortLinkSchema,
  type Experiment,
  type ExperimentResults,
  type FeedItemView,
  type LinkConversion,
  type LinkStats,
  type PostView,
  type ShortLink,
} from '@marketplace-sandbox/contracts';
import { JourneyClient, problemCode, unique } from './journey-client';
import { checkout, payOrder, waitOrderStatus, type CartLine } from './purchase';
import type { FixtureProduct, SellerFixture } from './seller-fixture';
import { waitForContract } from './wait-for-contract';

/** Where a share link may point: a page of the marketplace storefront (`FRONT_HOST` of the stack). */
export const FRONT = process.env.JOURNEY_FRONT_HOST ?? 'http://localhost:3000';

/**
 * The public routes of the engagement loop, as a kit (J05 G-19). Every call goes through a `JourneyClient`, parses the
 * contract and, where a resource is created on first use, answers `409` by opening the existing one (L-010).
 */
export const engagementFixture = {
  // --- follow and feed (S26) ----------------------------------------------------------------------------------------

  async follow(user: JourneyClient, accountId: string): Promise<number> {
    const reply = await user.post(`/api/follow/${accountId}`);
    return reply.status;
  },

  async unfollow(user: JourneyClient, accountId: string): Promise<number> {
    return (await user.call('DELETE', `/api/follow/${accountId}`)).status;
  },

  async followStatus(user: JourneyClient, accountIds: string[]) {
    const reply = await user.get('/api/follow-status', {
      query: { accountIds: accountIds.join(',') },
      schema: followStatusSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `follow-status: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return followStatusSchema.parse(reply.body);
  },

  async feed(user: JourneyClient): Promise<FeedItemView[]> {
    const items: FeedItemView[] = [];
    let cursor: string | undefined;
    do {
      const reply = await user.get('/api/feed', {
        query: { limit: 50, cursor },
        schema: feedPageSchema,
      });
      if (reply.status !== 200)
        throw new Error(`feed: ${reply.status} ${JSON.stringify(reply.body)}`);
      const page = feedPageSchema.parse(reply.body);
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  },

  /** One page of the feed (`limit` items from the newest). With a small `limit` the answer comes from the pushed timeline alone. */
  async feedPage(user: JourneyClient, limit: number): Promise<FeedItemView[]> {
    const reply = await user.get('/api/feed', {
      query: { limit },
      schema: feedPageSchema,
    });
    if (reply.status !== 200)
      throw new Error(`feed: ${reply.status} ${JSON.stringify(reply.body)}`);
    return feedPageSchema.parse(reply.body).items;
  },

  /** Polls the feed until `predicate` holds for the items; the hop is the deadline. */
  feedUntil(
    hop: 'J05.H2' | 'J05.H3' | 'J05.H4',
    user: JourneyClient,
    predicate: (items: FeedItemView[]) => boolean,
    what: string,
  ): Promise<FeedItemView[]> {
    return waitForContract(
      hop,
      async () => {
        const items = await engagementFixture.feed(user);
        return predicate(items) ? items : null;
      },
      what,
    );
  },

  // --- catalog ------------------------------------------------------------------------------------------------------

  /** A product the seller lists now; the feed learns of it from its event only. */
  async publishProduct(
    seller: SellerFixture,
    spec: {
      title?: string;
      priceMinor?: number;
      quantity?: number;
      category?: string;
      extra?: Record<string, unknown>;
    } = {},
  ): Promise<FixtureProduct> {
    const title = spec.title ?? unique('J05 Item');
    const priceMinor = spec.priceMinor ?? 2000;
    const created = await seller.owner.post<{ id: string }>(
      `/api/shops/${seller.shopId}/products`,
      {
        key: randomUUID(),
        body: {
          title,
          brand: 'Journey',
          category: spec.category ?? 'electronics',
          quantity: spec.quantity ?? 20,
          priceMinor,
          currency: 'EUR',
          description: `${title}. Created by the J05 journey.`,
          tags: ['journey'],
          ...spec.extra,
        },
      },
    );
    if (created.status !== 201)
      throw new Error(
        `publish product: ${created.status} ${JSON.stringify(created.body)}`,
      );
    return { id: created.body.id, title, priceMinor };
  },

  // --- discussions (S25) --------------------------------------------------------------------------------------------

  post(
    user: JourneyClient,
    boardId: string,
    key: string = randomUUID(),
    body: { title?: string; body?: string } = {},
  ) {
    return user.post<PostView>(`/api/boards/${boardId}/posts`, {
      key,
      body: {
        title: body.title ?? unique('J05 question'),
        body: body.body ?? 'Does this come in blue?',
      },
    });
  },

  comment(
    user: JourneyClient,
    postId: string,
    key: string = randomUUID(),
    text = 'Yes, in blue and green.',
  ) {
    return user.post(`/api/posts/${postId}/comments`, {
      key,
      body: { body: text },
    });
  },

  // --- share links (S37) --------------------------------------------------------------------------------------------

  /** `POST /links` with a key: the same key opens the same link (`200`/`201` with the same code). */
  async createLink(
    user: JourneyClient,
    productId: string,
    key: string = randomUUID(),
    options: { ttlDays?: number; destination?: string } = {},
  ) {
    const reply = await user.post<ShortLink>('/api/links', {
      key,
      body: {
        destination: options.destination ?? `${FRONT}/products/${productId}`,
        ...(options.ttlDays && { ttlDays: options.ttlDays }),
      },
    });
    return reply;
  },

  async linkOf(
    user: JourneyClient,
    productId: string,
    key?: string,
  ): Promise<ShortLink> {
    const reply = await engagementFixture.createLink(user, productId, key);
    if (reply.status !== 200 && reply.status !== 201)
      throw new Error(
        `create link: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return shortLinkSchema.parse(reply.body);
  },

  /** An anonymous visitor follows the short link: the `ref` of the redirect and its status. */
  async click(
    code: string,
  ): Promise<{ status: number; ref: string | null; location: string | null }> {
    const response = await fetch(
      `${process.env.API_URL ?? 'http://localhost:8000'}/api/l/${code}`,
      { redirect: 'manual' },
    );
    const location = response.headers.get('location');
    let ref: string | null = null;
    if (location) {
      try {
        ref = new URL(location, 'http://x').searchParams.get('ref');
      } catch {
        ref = null;
      }
    }
    return { status: response.status, ref, location };
  },

  async stats(owner: JourneyClient, code: string): Promise<LinkStats> {
    const reply = await owner.get(`/api/links/${code}/stats`, {
      query: { range: '24h' },
      schema: linkStatsSchema,
    });
    if (reply.status !== 200)
      throw new Error(`stats: ${reply.status} ${JSON.stringify(reply.body)}`);
    return linkStatsSchema.parse(reply.body);
  },

  async conversions(
    owner: JourneyClient,
    code: string,
  ): Promise<LinkConversion[]> {
    const items: LinkConversion[] = [];
    let cursor: string | undefined;
    do {
      const reply = await owner.get(`/api/links/${code}/conversions`, {
        query: { limit: 100, cursor },
        schema: linkConversionPageSchema,
      });
      if (reply.status !== 200)
        throw new Error(
          `conversions: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      const page = linkConversionPageSchema.parse(reply.body);
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  },

  // --- orders -------------------------------------------------------------------------------------------------------

  /** Puts the lines in the cart and checks out with an optional `ref`; returns the checkout answer (any status). */
  async referredCheckout(
    buyer: JourneyClient,
    lines: CartLine[],
    options: { ref?: string; key?: string } = {},
  ) {
    for (const line of lines) {
      const put = await buyer.put(`/api/cart/items/${line.product.id}`, {
        body: { quantity: line.quantity },
      });
      if (put.status >= 300)
        throw new Error(`cart: ${put.status} ${JSON.stringify(put.body)}`);
    }
    return buyer.post<{
      orderId: string;
      totalMinor: number;
      currency: string;
    }>('/api/checkout', {
      key: options.key ?? randomUUID(),
      body: options.ref === undefined ? {} : { ref: options.ref },
    });
  },

  /** A buyer's attributed (or not) order paid through the J01 chain, up to `PAID`. */
  async buy(
    buyer: JourneyClient,
    lines: CartLine[],
    options: { ref?: string } = {},
  ): Promise<{ orderId: string; totalMinor: number }> {
    const placed =
      options.ref === undefined ? await checkout(buyer, lines) : null;
    const answer = placed
      ? { orderId: placed.order.orderId, totalMinor: placed.order.totalMinor }
      : await (async () => {
          const reply = await engagementFixture.referredCheckout(
            buyer,
            lines,
            options,
          );
          if (reply.status !== 202)
            throw new Error(
              `checkout: ${reply.status} ${JSON.stringify(reply.body)}`,
            );
          return {
            orderId: reply.body.orderId,
            totalMinor: reply.body.totalMinor,
          };
        })();
    const accepted = await payOrder(buyer, answer.orderId);
    if (accepted.status !== 202)
      throw new Error(`pay: ${accepted.status} ${problemCode(accepted.body)}`);
    await waitOrderStatus(buyer, answer.orderId, 'PAID', 'H3');
    return answer;
  },

  /**
   * The provider's signed `charge.refunded` for an order (Stripe scheme, as J01's signed webhook): the only way a paid
   * order is refunded without a seller action. `refundedMinor` equal to the total is a full refund.
   */
  async refundWebhook(
    orderId: string,
    amountMinor: number,
    refundedMinor: number,
    stackNowMs: number,
  ): Promise<number> {
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${randomUUID()}`,
          payment_intent: `pi_scripted_${orderId}`,
          amount: amountMinor,
          amount_refunded: refundedMinor,
          currency: 'eur',
          metadata: { orderId },
        },
      },
    });
    const t = Math.floor(stackNowMs / 1000);
    const signature = createHmac('sha256', webhookSecret())
      .update(`${t}.${body}`)
      .digest('hex');
    const response = await fetch(
      `${process.env.API_URL ?? 'http://localhost:8000'}/api/webhooks/stripe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${t},v1=${signature}`,
        },
        body,
      },
    );
    return response.status;
  },

  // --- experiments (S39) --------------------------------------------------------------------------------------------

  /** A running `user`-unit `purchase` experiment of two equal variants, alone in its own layer. */
  async createExperiment(
    admin: JourneyClient,
    key: string = unique('j05-ex').toLowerCase(),
  ): Promise<Experiment> {
    const saved = await admin.put(`/api/admin/experiments/${key}`, {
      body: {
        expectedVersion: 0,
        description: 'J05 engagement loop',
        owner: 'j05-journey',
        unit: 'user',
        variants: [
          { key: 'control', weight: 5000 },
          { key: 'treatment', weight: 5000 },
        ],
        layer: key.slice(0, 31),
        layerFrom: 0,
        layerTo: 10000,
        metric: 'purchase',
      },
      schema: experimentSchema,
    });
    if (saved.status !== 201 && saved.status !== 200)
      throw new Error(
        `save experiment: ${saved.status} ${JSON.stringify(saved.body)}`,
      );
    const started = await admin.post(`/api/admin/experiments/${key}/start`, {
      schema: experimentSchema,
    });
    if (
      started.status !== 200 &&
      started.status !== 409 &&
      started.status !== 422
    )
      throw new Error(
        `start experiment: ${started.status} ${JSON.stringify(started.body)}`,
      );
    return experimentSchema.parse(
      (
        await admin.get(`/api/admin/experiments/${key}`, {
          schema: experimentSchema,
        })
      ).body,
    );
  },

  async assignment(user: JourneyClient, key: string): Promise<string | null> {
    const reply = await user.get<{
      assignments: Record<string, { variant: string }>;
      degraded: boolean;
    }>('/api/experiments/assignments');
    if (reply.status !== 200)
      throw new Error(
        `assignments: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    return reply.body.assignments[key]?.variant ?? null;
  },

  async results(admin: JourneyClient, key: string): Promise<ExperimentResults> {
    const reply = await admin.get(`/api/admin/experiments/${key}/results`, {
      schema: experimentResultsSchema,
    });
    if (reply.status !== 200)
      throw new Error(`results: ${reply.status} ${JSON.stringify(reply.body)}`);
    return experimentResultsSchema.parse(reply.body);
  },
};

function webhookSecret(): string {
  if (process.env.STRIPE_WEBHOOK_SECRET)
    return process.env.STRIPE_WEBHOOK_SECRET;
  const file =
    process.env.JOURNEY_ENV ??
    new URL('../../../.env', `file://${__dirname}/`).pathname;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('STRIPE_WEBHOOK_SECRET='));
  if (!line) throw new Error(`STRIPE_WEBHOOK_SECRET is not set in ${file}`);
  return line.slice('STRIPE_WEBHOOK_SECRET='.length).trim();
}
