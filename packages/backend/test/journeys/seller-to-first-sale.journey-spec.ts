import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ControlSurface, adminClient } from './support/control-surface';
import {
  JOURNEY_PASSWORD,
  JourneyClient,
  unique,
} from './support/journey-client';
import { kycFixtures, kycVariant, type KycName } from './support/kyc-fixtures';
import {
  answerAndSubmit,
  createEndpoint,
  createProduct,
  onboardVerified,
  openShop,
  randomIban,
  registerSeller,
  shopPriceId,
  subscribe,
  upload,
  type OpenShop,
} from './support/seller-fixture';
import { staysTrue, waitForContract } from './support/wait-for-contract';
import { RECEIVER_PORT, WebhookReceiver } from './support/webhook-receiver';
import {
  apiLogPath,
  logLinesSince,
  metricValue,
  readMetrics,
} from './support/observability';
import { checkout, payOrder, waitOrderStatus } from './support/purchase';
import {
  planLimitProblemSchema,
  productMemberSchema,
  productSearchResponseSchema,
  shopSchema,
  subscriptionSchema,
  JOURNEY_CONSUMER_GROUPS,
  leaderboardPageSchema,
  shopRankSchema,
  type LeaderboardPage,
  type ShopRank,
} from '@marketplace-sandbox/contracts';

/**
 * Journey J02: seller to first sale. Black box: public HTTP only; every test creates its own users, shops and products
 * (L-005, L-006); every wait is a contract hop (`J02.H1`..`J02.H17`), never a sleep (L-007). Scenario titles carry the
 * test-plan id `AS-nn` (L-017). The stories US1..US5 share one seller and run in order; US6 reads what they left.
 */
describe('Journey J02: seller to first sale', () => {
  let admin: JourneyClient;
  let control: ControlSurface;
  let receiver: WebhookReceiver;
  /** The shop AS-06 verified; AS-09 and AS-11 look at it again. */
  let verifiedShop: OpenShop;

  beforeAll(async () => {
    admin = await adminClient();
    control = new ControlSurface(admin);
    await control.restoreAll(); // a known stack: consumers running, clock real
    // J01 closes a month for good, and a sale in a closed month is sealed out of the boards (S40): when the stack's current
    // month is closed, this journey lives in the first month that is still open, as J01 does.
    await control.alignToOpenMonth();
    receiver = await WebhookReceiver.start();
    // The signature carries the stack's time: the receiver judges it by the stack's clock, not by this machine's.
    receiver.clockSkewMs = Date.parse((await control.clock()).now) - Date.now();
  });

  afterAll(async () => {
    await receiver?.stop();
    await control?.restoreAll({ endAdminSessions: true });
  });

  const roleOf = async (client: JourneyClient) => {
    const me = await client.get<{ role: string }>('/api/auth/me');
    return me.status === 200 ? me.body.role : null;
  };
  /** The role claim of a token obtained by a fresh sign-in. */
  const claimedRole = async (client: JourneyClient) => {
    await client.signIn(JOURNEY_PASSWORD);
    const payload = JSON.parse(
      Buffer.from(client.token!.split('.')[1], 'base64url').toString('utf8'),
    ) as { role?: string };
    return payload.role;
  };

  describe('US1: a visitor becomes a seller with a shop', () => {
    it('J02 AS-01: a visitor registers, signs in and opens a shop that is hers', async () => {
      const owner = await registerSeller('v');
      expect(await roleOf(owner)).toBe('USER');
      const key = randomUUID();
      const created = await owner.post('/api/shops', {
        body: { name: 'Journey Shop', slug: unique('as01') },
        key,
        schema: shopSchema,
      });
      expect(created.status).toBe(201);
      const shop = shopSchema.parse(created.body);
      expect(shop.myRole).toBe('OWNER');

      const mine = await owner.get<{ items: { id: string }[] }>(
        '/api/shops/mine',
      );
      expect(mine.body.items.map((s) => s.id)).toEqual([shop.id]);
    });

    it('J02 AS-02: the role follows the shop by event, and the next token carries it', async () => {
      const owner = await registerSeller('v');
      await openShop(owner);
      await waitForContract(
        'J02.H1',
        async () => ((await roleOf(owner)) === 'SELLER' ? true : null),
        'GET /auth/me role SELLER',
      );
      expect(await claimedRole(owner)).toBe('SELLER');
    });

    it('J02 AS-03: five concurrent creates with one key make one shop; another body with that key is refused', async () => {
      const owner = await registerSeller('v');
      const key = randomUUID();
      const body = { name: 'Same Shop', slug: unique('as03') };
      const replies = await Promise.all(
        Array.from({ length: 5 }, () =>
          owner.post<{ id: string }>('/api/shops', { body, key }),
        ),
      );
      const created = replies.filter(
        (r) => r.status === 201 || r.status === 200,
      );
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
      for (const r of replies) {
        if (r.status === 409)
          expect((r.body as unknown as { code: string }).code).toBe(
            'idempotency_in_flight', // never "slug taken": the key, not the slug, made the others wait
          );
        else expect([200, 201]).toContain(r.status);
      }
      const replay = await owner.post<{ id: string }>('/api/shops', {
        body,
        key,
      });
      expect(replay.status).toBe(201);
      expect(replay.body.id).toBe(created[0].body.id);
      const mine = await owner.get<{ items: { id: string }[] }>(
        '/api/shops/mine',
      );
      expect(mine.body.items).toHaveLength(1);

      const other = await owner.post('/api/shops', {
        body: { name: 'Another', slug: unique('as03b') },
        key,
      });
      expect(other.status).toBe(422);
    });

    it('J02 AS-04: a stranger gets 404 for the shop and its onboarding', async () => {
      const owner = await registerSeller('v');
      const { shopId } = await openShop(owner);
      const stranger = await registerSeller('x');
      expect((await stranger.get(`/api/shops/${shopId}`)).status).toBe(404);
      expect(
        (await stranger.get(`/api/shops/${shopId}/onboarding`)).status,
      ).toBe(404);
    });

    it('J02 AS-05: with the promotion consumer paused the shop works, the role waits, and it is promoted once on resume', async () => {
      const owner = await registerSeller('v');
      let shop: OpenShop;
      try {
        await control.pause('identity-seller-promotion');
        shop = await openShop(owner);
        await staysTrue(
          'J02.H1',
          async () => {
            expect(await roleOf(owner)).toBe('USER');
          },
          'the role stays USER while the group is paused',
        );
        expect((await owner.get(`/api/shops/${shop.shopId}`)).status).toBe(200);
        await waitForContract(
          'J02.H16',
          async () =>
            (await control.lag('identity-seller-promotion')) >= 1 ? true : null,
          'identity-seller-promotion lag >= 1',
        );
      } finally {
        await control.resume('identity-seller-promotion');
      }
      await waitForContract(
        'J02.H16',
        async () => ((await roleOf(owner)) === 'SELLER' ? true : null),
        'role SELLER after resume',
      );
      await waitForContract(
        'J02.H16',
        async () =>
          (await control.lag('identity-seller-promotion')) === 0 ? true : null,
        'identity-seller-promotion lag 0',
      );
    });
  });

  describe('US2: onboarding verification and final rejection', () => {
    interface OnboardingState {
      status: string;
      documents: { id: string; kind: string; status: string }[];
    }
    const onboardingOf = async (shop: OpenShop) =>
      (
        await shop.owner.get<OnboardingState>(
          `/api/shops/${shop.shopId}/onboarding`,
        )
      ).body;
    const shopOf = async (shop: OpenShop) =>
      (
        await shop.owner.get<{
          verificationStatus: string;
          payoutsEnabled: boolean;
          shopVersion: number;
        }>(`/api/shops/${shop.shopId}`)
      ).body;

    /** A fresh shop with the questionnaire submitted (registration number returned for the documents). */
    const submittedShop = async () => {
      const shop = await openShop(await registerSeller('o'));
      const number = await answerAndSubmit(shop.owner, shop.shopId);
      return { shop, number };
    };
    /** Uploads a KYC fixture made unique to this shop, with the fields the shop's own answers need. */
    const uploadKyc = (
      shop: OpenShop,
      name: KycName,
      number: string,
      fields: Record<string, string> = {},
    ) => {
      const fixture = kycFixtures[name];
      const own: Record<string, string> = {
        legalName: 'Müller Handels GmbH',
        registrationNumber: `HRB${number}`,
        accountHolder: 'Müller Handels GmbH',
        iban: randomIban(),
        statementDate: new Date(Date.now() - 10 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        ...fields,
      };
      return upload(
        shop.owner,
        shop.shopId,
        fixture.kind,
        kycVariant(fixture, { fields: own }),
      );
    };
    const documentStatus = async (shop: OpenShop, kind: string) =>
      (await onboardingOf(shop)).documents.find((d) => d.kind === kind)?.status;
    const reviewTaskFor = async (shop: OpenShop, kind: string) =>
      waitForContract(
        'J02.H3',
        async () => {
          let cursor: string | undefined;
          do {
            const page = await admin.get<{
              items: { id: string; shopId: string; kind: string }[];
              nextCursor: string | null;
            }>('/api/admin/onboarding/reviews', {
              query: { limit: 100, cursor },
            });
            const found = page.body.items.find(
              (i) => i.shopId === shop.shopId && i.kind === kind,
            );
            if (found) return found;
            cursor = page.body.nextCursor ?? undefined;
          } while (cursor);
          return null;
        },
        `a review task of ${kind} for the shop`,
      );
    const waitShop = (
      shop: OpenShop,
      hop: 'J02.H2' | 'J02.H4' | 'J02.H5',
      status: string,
    ) =>
      waitForContract(
        hop,
        async () => {
          const s = await shopOf(shop);
          return s.verificationStatus === status ? s : null;
        },
        `shop ${status}`,
      );

    it('J02 AS-06: the documents are read automatically and the shop is verified with payouts enabled', async () => {
      const { shop, number } = await submittedShop();
      await waitShop(shop, 'J02.H2', 'PENDING');
      await uploadKyc(shop, 'kyc-ok-registration', number);
      await uploadKyc(shop, 'kyc-ok-bank', number);
      await waitForContract(
        'J02.H3',
        async () =>
          (await onboardingOf(shop)).documents.every(
            (d) => d.status === 'APPROVED',
          )
            ? true
            : null,
        'both documents APPROVED',
      );
      const verified = await waitShop(shop, 'J02.H4', 'VERIFIED');
      expect(verified.payoutsEnabled).toBe(true);
      expect((await onboardingOf(shop)).status).toBe('VERIFIED');
      verifiedShop = shop;
    });

    it('J02 AS-07: a document the model is unsure of waits for a person; only an administrator decides', async () => {
      const { shop, number } = await submittedShop();
      await uploadKyc(shop, 'kyc-ok-bank', number);
      await uploadKyc(shop, 'kyc-unclear', number);
      await waitForContract(
        'J02.H3',
        async () =>
          (await documentStatus(shop, 'BUSINESS_REGISTRATION')) ===
          'NEEDS_REVIEW'
            ? true
            : null,
        'registration NEEDS_REVIEW',
      );
      const task = await reviewTaskFor(shop, 'BUSINESS_REGISTRATION');
      const refused = await shop.owner.post(
        `/api/admin/onboarding/reviews/${task.id}/resolve`,
        { body: { decision: 'APPROVE' } },
      );
      expect(refused.status).toBe(403);
      const decided = await admin.post<{ status: string }>(
        `/api/admin/onboarding/reviews/${task.id}/resolve`,
        { body: { decision: 'APPROVE' } },
      );
      expect(decided.status).toBe(200);
      expect(decided.body.status).toBe('APPROVED');
      await waitShop(shop, 'J02.H4', 'VERIFIED');
    });

    it('J02 AS-08: a forged document ends in a final rejection of the application, and an old verification cannot undo it', async () => {
      const { shop, number } = await submittedShop();
      await uploadKyc(shop, 'kyc-ok-bank', number);
      await uploadKyc(shop, 'kyc-forged', number);
      const task = await reviewTaskFor(shop, 'BUSINESS_REGISTRATION');
      const decided = await admin.post<{ status: string }>(
        `/api/admin/onboarding/reviews/${task.id}/resolve`,
        {
          body: {
            decision: 'REJECT_APPLICATION',
            reasonCode: 'DOCUMENTS_INVALID',
            reason: 'The registration extract is not genuine',
          },
        },
      );
      expect(decided.status).toBe(200);
      expect(decided.body.status).toBe('APPLICATION_REJECTED');
      const rejected = await waitShop(shop, 'J02.H5', 'REJECTED');
      expect(rejected.payoutsEnabled).toBe(false);
      expect((await onboardingOf(shop)).status).toBe('REJECTED');

      // a replay of everything tenancy ever consumed must leave the rejection standing
      const since = new Date(Date.now() - 15 * 60_000);
      await control.replay('tenancy-shop-lifecycle', since);
      await control.waitCaughtUp('tenancy-shop-lifecycle');
      const after = await shopOf(shop);
      expect(after).toMatchObject({
        verificationStatus: 'REJECTED',
        payoutsEnabled: false,
        shopVersion: rejected.shopVersion,
      });
    });

    it('J02 AS-09: replaying the onboarding events changes nothing on a verified shop', async () => {
      expect(verifiedShop).toBeDefined(); // set by AS-06
      const before = await shopOf(verifiedShop);
      await control.replay(
        'tenancy-shop-lifecycle',
        new Date(Date.now() - 15 * 60_000),
      );
      await control.waitCaughtUp('tenancy-shop-lifecycle');
      expect(await shopOf(verifiedShop)).toEqual(before);
      expect((await onboardingOf(verifiedShop)).status).toBe('VERIFIED');
    });

    it('J02 AS-10: with the extractor held the document waits QUEUED, and is decided after the hold ends', async () => {
      const { shop, number } = await submittedShop();
      await waitShop(shop, 'J02.H2', 'PENDING');
      try {
        await control.pause('document-extractor');
        await uploadKyc(shop, 'kyc-ok-registration', number);
        await uploadKyc(shop, 'kyc-ok-bank', number);
        await staysTrue(
          'J02.H2',
          async () => {
            expect(await documentStatus(shop, 'BANK_STATEMENT')).toBe('QUEUED');
            expect((await shopOf(shop)).verificationStatus).toBe('PENDING');
          },
          'the documents stay QUEUED while the extractor is held',
        );
      } finally {
        await control.resume('document-extractor');
      }
      await waitShop(shop, 'J02.H4', 'VERIFIED');
      // confirming an upload again changes nothing (idempotent)
      const documents = (await onboardingOf(shop)).documents;
      for (const doc of documents) {
        const again = await shop.owner.post(
          `/api/shops/${shop.shopId}/onboarding/documents/${doc.id}/uploaded`,
        );
        expect(again.status).toBe(200);
      }
      expect((await shopOf(shop)).verificationStatus).toBe('VERIFIED');
    });

    it('J02 AS-11: the verify-pending sweep, run twice, leaves a verified shop exactly as it is', async () => {
      // The crash between the last approval and the verification cannot be staged through public routes; that
      // state is proved in the domain's own e2e (S04 G-09). Here the journey proves the control-surface path and its idempotence.
      expect(verifiedShop).toBeDefined();
      const before = await shopOf(verifiedShop);
      for (const _ of [1, 2]) {
        const job = await control.runJob('onboarding.verify-pending');
        expect(job.status).toBe('SUCCEEDED');
      }
      expect(await shopOf(verifiedShop)).toEqual(before);
    });
  });

  describe('US3: subscription and entitlements exactly once', () => {
    interface SubscriptionRead {
      subscription: {
        status: string;
        plan: { code: string };
        latestInvoice: { id: string; status: string } | null;
      } | null;
      entitlements: Record<string, number | boolean>;
    }
    const readSubscription = async (shop: OpenShop) =>
      (
        await shop.owner.get<SubscriptionRead>(
          `/api/shops/${shop.shopId}/subscription`,
        )
      ).body;
    const invoicesOf = async (shop: OpenShop) =>
      (
        await shop.owner.get<{ items: { id: string; status: string }[] }>(
          `/api/shops/${shop.shopId}/invoices`,
        )
      ).body.items;
    const planOf = async (shop: OpenShop) =>
      (await shop.owner.get<{ plan: string }>(`/api/shops/${shop.shopId}`)).body
        .plan;
    const freshShop = async () => openShop(await registerSeller('s'));

    it('J02 AS-12: subscribing charges once; the paid plan applies only after the invoice is paid', async () => {
      const shop = await freshShop();
      const free = (await readSubscription(shop)).entitlements.maxProducts;
      const { maxProducts: paid } = await shopPriceId(shop.owner, 'pro');
      expect(paid).not.toBeNull();
      expect(paid).not.toBe(free);

      const accepted = await subscribe(shop, 'pm_test_visa');
      expect(accepted.status).toBe(201);
      subscriptionSchema.parse(accepted.body);

      // whatever the moment, the paid limits never show before the first invoice is PAID
      await waitForContract(
        'J02.H6',
        async () => {
          const read = await readSubscription(shop);
          const invoice = read.subscription?.latestInvoice;
          if (invoice?.status !== 'PAID') {
            expect(read.entitlements.maxProducts).toBe(free);
            return null;
          }
          return read.subscription?.status === 'ACTIVE' ? read : null;
        },
        'invoice PAID and subscription ACTIVE',
      );
      await waitForContract(
        'J02.H7',
        async () =>
          (await readSubscription(shop)).entitlements.maxProducts === paid
            ? true
            : null,
        `maxProducts ${paid}`,
      );
      await waitForContract(
        'J02.H8',
        async () => ((await planOf(shop)) === 'PRO' ? true : null),
        'Shop.plan PRO',
      );
      expect(
        (await invoicesOf(shop)).filter((i) => i.status === 'PAID'),
      ).toHaveLength(1);
    });

    it('J02 AS-13: a retried subscribe is one invoice; another body with the key and a missing key are refused', async () => {
      const shop = await freshShop();
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 5 }, () =>
          subscribe(shop, 'pm_test_visa', { key }),
        ),
      );
      for (const r of replies) {
        if (r.status === 409)
          expect((r.body as { code?: string }).code).toBe(
            'idempotency_in_flight',
          );
        else expect([200, 201]).toContain(r.status);
      }
      const ids = new Set(
        replies.filter((r) => r.status < 300).map((r) => r.body.id as string),
      );
      expect(ids.size).toBe(1);
      await waitForContract(
        'J02.H6',
        async () =>
          (await invoicesOf(shop)).some((i) => i.status === 'PAID')
            ? true
            : null,
        'invoice PAID',
      );
      expect(await invoicesOf(shop)).toHaveLength(1);

      const { priceId } = await shopPriceId(shop.owner, 'pro');
      const other = await shop.owner.post(
        `/api/shops/${shop.shopId}/subscription`,
        {
          body: { priceId, quantity: 2, paymentMethodRef: 'pm_test_visa' },
          key,
        },
      );
      expect(other.status).toBe(422);
      const none = await shop.owner.post(
        `/api/shops/${shop.shopId}/subscription`,
        {
          body: { priceId, paymentMethodRef: 'pm_test_visa' },
        },
      );
      expect(none.status).toBe(422);
      expect((none.body as { code?: string }).code).toBe(
        'idempotency_key_required',
      );
    });

    it('J02 AS-14: a declined first charge keeps the free tier; a working method and the next billing run activate it', async () => {
      const shop = await freshShop();
      const free = (await readSubscription(shop)).entitlements.maxProducts;
      expect((await subscribe(shop, 'pm_test_declined')).status).toBe(201);
      await staysTrue(
        'J02.H6',
        async () => {
          const read = await readSubscription(shop);
          expect(read.entitlements.maxProducts).toBe(free);
          expect(read.subscription?.latestInvoice?.status).not.toBe('PAID');
        },
        'the free tier while the charge is declined',
      );
      const fixed = await shop.owner.put(
        `/api/shops/${shop.shopId}/subscription/payment-method`,
        { body: { paymentMethodRef: 'pm_test_visa' } },
      );
      expect(fixed.status).toBe(200);
      try {
        await control.advance(2 * 86_400);
        await waitForContract(
          'J02.H17',
          async () => {
            const job = await control.runJob('billing.run');
            expect(job.status).toBe('SUCCEEDED');
            return (await readSubscription(shop)).subscription?.status ===
              'ACTIVE'
              ? true
              : null;
          },
          'subscription ACTIVE after the billing run',
        );
      } finally {
        await control.rebase();
      }
      expect((await readSubscription(shop)).entitlements.maxProducts).not.toBe(
        free,
      );
    });

    it('J02 AS-15: with the invalidation consumer paused the cached free tier stays until it catches up', async () => {
      const shop = await freshShop();
      const free = (await readSubscription(shop)).entitlements.maxProducts; // warms the cache
      const { maxProducts: paid } = await shopPriceId(shop.owner, 'pro');
      try {
        await control.pause('entitlements-invalidation');
        expect((await subscribe(shop, 'pm_test_visa')).status).toBe(201);
        // every poll reads the entitlements too, so the free tier is cached when the payment lands
        await waitForContract(
          'J02.H6',
          async () =>
            (await readSubscription(shop)).subscription?.latestInvoice
              ?.status === 'PAID'
              ? true
              : null,
          'invoice PAID',
        );
        await staysTrue(
          'J02.H7',
          async () => {
            expect(
              (await readSubscription(shop)).entitlements.maxProducts,
            ).toBe(free);
          },
          'the cached entitlements while the consumer is paused',
        );
      } finally {
        await control.resume('entitlements-invalidation');
      }
      await waitForContract(
        'J02.H7',
        async () =>
          (await readSubscription(shop)).entitlements.maxProducts === paid
            ? true
            : null,
        'entitlements caught up',
      );
    });

    it('J02 AS-16: replaying the billing events changes nothing', async () => {
      const shop = await freshShop();
      expect((await subscribe(shop, 'pm_test_visa')).status).toBe(201);
      await waitForContract(
        'J02.H8',
        async () => ((await planOf(shop)) === 'PRO' ? true : null),
        'Shop.plan PRO',
      );
      const snapshot = async () => ({
        read: await readSubscription(shop),
        invoices: await invoicesOf(shop),
        plan: await planOf(shop),
      });
      const before = await snapshot();
      const since = new Date(Date.now() - 15 * 60_000);
      for (const group of [
        'tenancy-shop-lifecycle',
        'entitlements-invalidation',
      ]) {
        await control.replay(group, since);
        await control.waitCaughtUp(group);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  /**
   * The seller of US4 and US5: a verified shop on the paid plan with a webhook endpoint at the receiver. Built once, on first
   * use, so any story can be run alone with `-t`.
   */
  interface ReadySeller extends OpenShop {
    endpointId: string;
  }
  let readyPromise: Promise<ReadySeller> | undefined;
  const readySeller = () => {
    readyPromise ??= (async () => {
      const shop = await openShop(await registerSeller('r'));
      await onboardVerified(shop);
      const accepted = await subscribe(shop, 'pm_test_visa');
      expect(accepted.status).toBe(201);
      await waitForContract(
        'J02.H7',
        async () => {
          const read = await shop.owner.get<{
            entitlements: Record<string, number>;
          }>(`/api/shops/${shop.shopId}/subscription`);
          return read.body.entitlements.maxProducts > 10 ? true : null;
        },
        'the paid plan applies',
      );
      const endpoint = await createEndpoint(shop, receiver.url(), [
        'order.paid',
        'product.created',
      ]);
      expect(endpoint.status).toBe(201);
      receiver.secret = endpoint.body.secret;
      return { ...shop, endpointId: endpoint.body.id };
    })();
    return readyPromise;
  };

  interface SearchHit {
    id: string;
    shopId: string;
    title: string;
    priceMinor: number;
    inStock: boolean;
  }
  const searchFor = async (title: string, client?: JourneyClient) => {
    const reply = await (client ?? new JourneyClient('anon@example.com')).get(
      '/api/products/search',
      { query: { q: title, limit: 20 }, schema: productSearchResponseSchema },
    );
    expect(reply.status).toBe(200);
    return (reply.body as { items: SearchHit[] }).items.filter(
      (hit) => hit.title === title,
    );
  };
  const waitSearch = (
    hop: 'J02.H9' | 'J02.H10' | 'J02.H11',
    title: string,
    predicate: (hits: SearchHit[]) => boolean,
    what: string,
  ) =>
    waitForContract(
      hop,
      async () => {
        const hits = await searchFor(title);
        return predicate(hits) ? hits : null;
      },
      what,
    );
  const productsOf = async (shop: OpenShop) =>
    (
      await shop.owner.get<{ items: { id: string; title: string }[] }>(
        `/api/shops/${shop.shopId}/products`,
        { query: { limit: 100 } },
      )
    ).body.items;

  describe('US4: plan limit and search', () => {
    it('J02 AS-17: the plan limit applies, and subscribing raises it', async () => {
      const shop = await openShop(await registerSeller('l'));
      const free = (
        await shop.owner.get<{ entitlements: Record<string, number> }>(
          `/api/shops/${shop.shopId}/subscription`,
        )
      ).body.entitlements.maxProducts;
      for (let i = 0; i < free; i++)
        expect(
          (await createProduct(shop, { title: unique('Lim') })).status,
        ).toBe(201);
      const refused = await createProduct(shop, { title: unique('Over') });
      expect(refused.status).toBe(409);
      expect(planLimitProblemSchema.parse(refused.body)).toMatchObject({
        code: 'plan_limit_reached',
        key: 'maxProducts',
        limit: free,
      });
      expect(await productsOf(shop)).toHaveLength(free);

      expect((await subscribe(shop, 'pm_test_visa')).status).toBe(201);
      await waitForContract(
        'J02.H8',
        async () => {
          const created = await createProduct(shop, { title: unique('Paid') });
          return created.status === 201 ? created : null;
        },
        'a product can be created on the paid plan',
      );
    });

    it('J02 AS-18: a listed product is found by anyone, and the shop hears about it', async () => {
      const shop = await readySeller();
      const title = unique('Findable');
      const created = await createProduct(shop, { title, priceMinor: 1500 });
      expect(created.status).toBe(201);
      productMemberSchema.parse(created.body);
      const id = created.body.id as string;
      expect(
        (await new JourneyClient('anon@example.com').get(`/api/products/${id}`))
          .status,
      ).toBe(200);

      const hits = await waitSearch(
        'J02.H9',
        title,
        (h) => h.length === 1,
        'the product in search',
      );
      expect(hits[0]).toMatchObject({
        id,
        shopId: shop.shopId,
        priceMinor: 1500,
        inStock: true,
      });
      expect((await productsOf(shop)).map((p) => p.id)).toContain(id);

      const delivered = await waitForContract(
        'J02.H12',
        async () =>
          receiver
            .ofType('product.created')
            .find((r) => r.body.data?.object?.id === id) ?? null,
        'product.created at the receiver',
      );
      expect(delivered.verified).toBe(true);
      expect(delivered.attempt).toBe(1);
    });

    it('J02 AS-19: five concurrent creates with one key make one product, one hit and one event', async () => {
      const shop = await readySeller();
      const title = unique('Once');
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 5 }, () => createProduct(shop, { title }, key)),
      );
      for (const r of replies) expect([200, 201, 409]).toContain(r.status);
      const ids = new Set(
        replies.filter((r) => r.status < 300).map((r) => r.body.id as string),
      );
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      await waitSearch(
        'J02.H9',
        title,
        (h) => h.length >= 1,
        'the product in search',
      );
      expect(await searchFor(title)).toHaveLength(1);
      expect(
        (await productsOf(shop)).filter((p) => p.title === title),
      ).toHaveLength(1);
      await waitForContract(
        'J02.H12',
        async () =>
          receiver
            .ofType('product.created')
            .some((r) => r.body.data?.object?.id === id)
            ? true
            : null,
        'product.created at the receiver',
      );
      const eventIds = new Set(
        receiver
          .ofType('product.created')
          .filter((r) => r.body.data?.object?.id === id)
          .map((r) => r.id),
      );
      expect(eventIds.size).toBe(1);
    });

    it('J02 AS-20: with the index consumer paused the product is saved but not searchable, until it catches up once', async () => {
      const shop = await readySeller();
      const title = unique('Late');
      let id = '';
      try {
        await control.pause('search-product-index');
        const created = await createProduct(shop, { title });
        expect(created.status).toBe(201);
        id = created.body.id;
        expect(
          (
            await new JourneyClient('anon@example.com').get(
              `/api/products/${id}`,
            )
          ).status,
        ).toBe(200);
        expect((await productsOf(shop)).map((p) => p.id)).toContain(id);
        await staysTrue(
          'J02.H9',
          async () => {
            expect(await searchFor(title)).toHaveLength(0);
          },
          'not searchable while the consumer is paused',
        );
        expect(
          await control.lag('search-product-index'),
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await control.resume('search-product-index');
      }
      await waitSearch(
        'J02.H9',
        title,
        (h) => h.length === 1,
        'searchable after resume',
      );
      await waitForContract(
        'J02.H16',
        async () =>
          (await control.lag('search-product-index')) === 0 ? true : null,
        'lag 0',
      );
      expect(await searchFor(title)).toHaveLength(1);
    });

    it('J02 AS-21: edits, archive and restore reach search in order, and a replay changes nothing', async () => {
      const shop = await readySeller();
      const oldTitle = unique('Before');
      const newTitle = unique('After');
      const created = await createProduct(shop, { title: oldTitle });
      const id = created.body.id as string;
      await waitSearch('J02.H9', oldTitle, (h) => h.length === 1, 'indexed');
      const base = `/api/shops/${shop.shopId}/products/${id}`;
      const patched = await shop.owner.call<{ version: number }>(
        'PATCH',
        base,
        {
          body: { expectedVersion: created.body.version, title: newTitle },
        },
      );
      expect(patched.status).toBe(200);
      const archived = await shop.owner.post<{ version: number }>(
        `${base}/archive`,
        {
          body: { expectedVersion: patched.body.version },
        },
      );
      expect(archived.status).toBe(200);
      const restored = await shop.owner.post(`${base}/restore`, {
        body: { expectedVersion: archived.body.version },
      });
      expect(restored.status).toBe(200);

      await waitSearch(
        'J02.H10',
        newTitle,
        (h) => h.length === 1,
        'the final title',
      );
      expect(await searchFor(oldTitle)).toHaveLength(0);

      await control.replay(
        'search-product-index',
        new Date(Date.now() - 15 * 60_000),
      );
      await control.waitCaughtUp('search-product-index');
      expect(await searchFor(newTitle)).toHaveLength(1);
      expect(await searchFor(oldTitle)).toHaveLength(0);
    });

    it('J02 AS-22: suspending a shop hides its products; reinstating shows them again', async () => {
      const shop = await readySeller();
      const title = unique('Hide');
      await createProduct(shop, { title });
      await waitSearch('J02.H9', title, (h) => h.length === 1, 'indexed');
      try {
        const suspended = await admin.post(
          `/api/admin/shops/${shop.shopId}/suspend`,
          {
            body: { reason: 'journey check' },
          },
        );
        expect(suspended.status).toBeLessThan(300);
        await waitSearch('J02.H11', title, (h) => h.length === 0, 'hidden');
      } finally {
        const back = await admin.post(
          `/api/admin/shops/${shop.shopId}/reinstate`,
          {
            body: { reason: 'journey check done' },
          },
        );
        expect(back.status).toBeLessThan(300);
      }
      await waitSearch('J02.H11', title, (h) => h.length === 1, 'shown again');
    });

    it('J02 AS-23: a shop and a product created while the consumer is down appear once, never flicker', async () => {
      const seller = await registerSeller('f');
      const title = unique('Flicker');
      try {
        await control.pause('search-product-index');
        const shop = await openShop(seller);
        expect((await createProduct(shop, { title })).status).toBe(201);
        expect(await searchFor(title)).toHaveLength(0);
      } finally {
        await control.resume('search-product-index');
      }
      const seen: number[] = [];
      await waitForContract(
        'J02.H9',
        async () => {
          seen.push((await searchFor(title)).length);
          return seen.at(-1) === 1 ? true : null;
        },
        'the product after resume',
      );
      for (let i = 0; i < 8; i++) seen.push((await searchFor(title)).length);
      const first = seen.indexOf(1);
      expect(seen.slice(first).every((n) => n === 1)).toBe(true);
    });
  });

  describe('US5: the first sale reaches webhooks and the leaderboard', () => {
    const endpointBase = (shop: OpenShop, id: string) =>
      `/api/shops/${shop.shopId}/developers/webhooks/${id}`;
    /** A buyer of their own buys one of each product through the J01 chain and the order is paid. */
    const sell = async (
      lines: { id: string; title: string; priceMinor: number }[],
      pm = 'pm_test_visa',
    ) => {
      const buyer = await JourneyClient.signUp('buyer');
      const { order } = await checkout(
        buyer,
        lines.map((product) => ({ product, quantity: 1 })),
      );
      const accepted = await payOrder(buyer, order.orderId, pm);
      expect(accepted.status).toBe(202);
      return { buyer, orderId: order.orderId };
    };
    const listed = async (
      shop: OpenShop,
      overrides: { priceMinor?: number } = {},
    ) => {
      const title = unique('Sale');
      const priceMinor = overrides.priceMinor ?? 1500;
      const created = await createProduct(shop, { title, priceMinor });
      expect(created.status).toBe(201);
      return { id: created.body.id as string, title, priceMinor };
    };
    const rankOf = (shop: OpenShop) =>
      shop.owner.get(`/api/shops/${shop.shopId}/rank`, {
        schema: shopRankSchema,
      });
    const revenueNow = async (shop: OpenShop) => {
      const reply = await rankOf(shop);
      return reply.status === 200 ? (reply.body as ShopRank).revenueMinor : 0;
    };
    const waitRank = (
      shop: OpenShop,
      predicate: (revenue: number) => boolean,
    ) =>
      waitForContract(
        'J02.H14',
        async () => {
          const reply = await rankOf(shop);
          if (reply.status !== 200) return null;
          const rank = reply.body as ShopRank;
          return predicate(rank.revenueMinor) ? rank : null;
        },
        'the rank of the shop',
      );
    const isOrder = (orderId: string) => (r: { body: Record<string, any> }) =>
      r.body.data?.object?.id === orderId;
    const paidAt = (orderId: string, at: WebhookReceiver = receiver) =>
      waitForContract(
        'J02.H13',
        async () => at.ofType('order.paid').find(isOrder(orderId)) ?? null,
        `order.paid of ${orderId} at the receiver`,
      );
    const attemptsOf = (shop: OpenShop, endpointId: string, eventId: string) =>
      shop.owner.get<{
        items: { ok: boolean; attempt: number; eventId: string }[];
      }>(`${endpointBase(shop, endpointId)}/attempts`, { query: { eventId } });
    const boardEntry = async (shopId: string) => {
      const page = await new JourneyClient('anon@example.com').get(
        '/api/leaderboards',
        {
          query: { period: 'week' },
          schema: leaderboardPageSchema,
        },
      );
      const entries = (page.body as LeaderboardPage).entries ?? [];
      const index = entries.findIndex((e) => e.shopId === shopId);
      return index < 0 ? null : { entry: entries[index], position: index + 1 };
    };

    it('J02 AS-24: the shop gets a webhook endpoint; the secret is shown once; only the shop manages it', async () => {
      const shop = await readySeller();
      // `readySeller` already holds an endpoint at `/hook`: a second one at the same address is `409 duplicate_endpoint_url`.
      const duplicate = await createEndpoint(shop, receiver.url(), [
        'order.paid',
      ]);
      expect(duplicate.status).toBe(409);
      const created = await createEndpoint(shop, receiver.url('/second'), [
        'product.created',
        'order.paid',
      ]);
      expect(created.status).toBe(201);
      expect(created.body.secret).toBeTruthy();
      const read = await shop.owner.get(endpointBase(shop, created.body.id));
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(created.body.secret);
      const stranger = await openShop(await registerSeller('x'));
      expect(
        (await stranger.owner.get(endpointBase(shop, created.body.id))).status,
      ).toBe(404);
      await shop.owner.call('DELETE', endpointBase(shop, created.body.id));
    });

    it('J02 AS-25: the sale reaches the shop once, signed and sliced, and moves search, rank and board', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      await waitSearch(
        'J02.H9',
        product.title,
        (h) => h.length === 1,
        'indexed',
      );
      expect((await rankOf(shop)).status).toBe(404);
      const { orderId } = await sell([product]);
      await waitSearch(
        'J02.H10',
        product.title,
        (h) => h[0]?.inStock === false,
        'sold out in search',
      );
      const delivered = await paidAt(orderId);
      expect(delivered.verified).toBe(true);
      expect(delivered.attempt).toBe(1);
      expect(delivered.body).toMatchObject({
        object: 'event',
        type: 'order.paid',
      });
      expect(delivered.body.resource_version).toBeDefined();
      const object = delivered.body.data.object;
      // S43 `contracts/outbound.md`: `{id, object, shop_order_id, status, total, lines[{product_id, ...}]}`, only this shop's part.
      expect(
        object.lines.map((l: { product_id: string }) => l.product_id),
      ).toEqual([product.id]);
      expect(object.total).toEqual({
        amount: product.priceMinor,
        currency: expect.any(String),
      });
      expect(
        receiver.ofType('order.paid').filter(isOrder(orderId)),
      ).toHaveLength(1);
      const attempts = await attemptsOf(shop, shop.endpointId, delivered.id);
      expect(attempts.body.items).toHaveLength(1);
      expect(attempts.body.items[0].ok).toBe(true);

      const rank = await waitRank(
        shop,
        (revenue) => revenue >= product.priceMinor,
      );
      expect(rank.rank).toBeGreaterThanOrEqual(1);
      expect(rank.of).toBeGreaterThanOrEqual(1);
      const board = await waitForContract(
        'J02.H15',
        async () => (await boardEntry(shop.shopId))?.entry ?? null,
        'the shop on the board',
      );
      expect(board.slug).toBe(shop.slug);
      expect(board.name).toBeTruthy();
      expect(board.name).not.toBe('Unknown shop');
      expect(board).not.toHaveProperty('revenueMinor');
    });

    it('J02 AS-26: an order of two shops tells and ranks each shop only about its own lines', async () => {
      const shop = await readySeller();
      const other = await openShop(await registerSeller('o'));
      await onboardVerified(other);
      const receiverX = await WebhookReceiver.start(RECEIVER_PORT + 1);
      try {
        const endpointX = await createEndpoint(other, receiverX.url(), [
          'order.paid',
        ]);
        expect(endpointX.status).toBe(201);
        receiverX.secret = endpointX.body.secret;
        const mine = await listed(shop);
        const theirs = await listed(other, { priceMinor: 2500 });
        const before = await revenueNow(shop);
        const { orderId } = await sell([mine, theirs]);
        const ours = await paidAt(orderId);
        const theirsDelivered = await paidAt(orderId, receiverX);
        expect(ours.id).not.toBe(theirsDelivered.id);
        expect(ours.body.data.object.total.amount).toBe(mine.priceMinor);
        expect(
          ours.body.data.object.lines.map(
            (l: { product_id: string }) => l.product_id,
          ),
        ).toEqual([mine.id]);
        expect(theirsDelivered.body.data.object.total.amount).toBe(
          theirs.priceMinor,
        );
        expect(
          theirsDelivered.body.data.object.lines.map(
            (l: { product_id: string }) => l.product_id,
          ),
        ).toEqual([theirs.id]);
        await waitRank(shop, (revenue) => revenue === before + mine.priceMinor);
        await waitRank(other, (revenue) => revenue === theirs.priceMinor);
      } finally {
        await receiverX.stop();
      }
    });

    it('J02 AS-27: a receiver that fails then recovers gets the same event id once, and a replay is marked', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      receiver.answer(500);
      let eventId = '';
      try {
        const { orderId } = await sell([product]);
        const first = await paidAt(orderId);
        eventId = first.id;
        expect(first.attempt).toBe(1);
        const failed = await attemptsOf(shop, shop.endpointId, eventId);
        expect(failed.body.items.some((a) => !a.ok)).toBe(true);
        receiver.answer(200);
        await waitForContract(
          'J02.H13',
          async () => {
            await control.advance(60);
            await control.runJob('webhooks.retry');
            const done = (
              await attemptsOf(shop, shop.endpointId, eventId)
            ).body.items.some((a) => a.ok);
            return done ? true : null;
          },
          'a successful retry',
        );
      } finally {
        receiver.answer(200);
        await control.rebase(); // back to where the journey lives, not to real time (a closed month)
      }
      const wire = receiver.forEvent(eventId);
      expect(new Set(wire.map((r) => r.id)).size).toBe(1);
      expect(wire.length).toBeGreaterThanOrEqual(2);

      const replayed = await shop.owner.post(
        `${endpointBase(shop, shop.endpointId)}/events/${eventId}/replay`,
        { body: {}, key: randomUUID() },
      );
      expect(replayed.status).toBe(202);
      const again = await waitForContract(
        'J02.H13',
        async () => receiver.forEvent(eventId).find((r) => r.replay) ?? null,
        'the replay at the receiver',
      );
      expect(again.id).toBe(eventId);
    });

    it('J02 AS-28: with the router or the board consumer down nothing is lost, and nothing happens twice', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      const base = await revenueNow(shop);
      let orderId = '';
      try {
        await control.pause('webhook-router');
        ({ orderId } = await sell([product]));
        await waitRank(
          shop,
          (revenue) => revenue === base + product.priceMinor,
        );
        await staysTrue(
          'J02.H13',
          async () => {
            expect(receiver.ofType('order.paid').some(isOrder(orderId))).toBe(
              false,
            );
          },
          'no webhook while the router is paused',
        );
        expect(await control.lag('webhook-router')).toBeGreaterThanOrEqual(1);
      } finally {
        await control.resume('webhook-router');
      }
      await paidAt(orderId);
      await control.waitCaughtUp('webhook-router');
      expect(
        receiver.ofType('order.paid').filter(isOrder(orderId)),
      ).toHaveLength(1);

      const second = await listed(shop);
      const current = await revenueNow(shop);
      try {
        await control.pause('leaderboards');
        await sell([second]);
        await staysTrue(
          'J02.H14',
          async () => {
            expect(await revenueNow(shop)).toBe(current);
          },
          'rank unchanged while the board consumer is paused',
        );
      } finally {
        await control.resume('leaderboards');
      }
      await waitRank(
        shop,
        (revenue) => revenue === current + second.priceMinor,
      );
      await control.waitCaughtUp('leaderboards');
    });

    it('J02 AS-29: replaying the order and product events changes no observable', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      const { orderId } = await sell([product]);
      await paidAt(orderId);
      const rank = await waitRank(
        shop,
        (revenue) => revenue >= product.priceMinor,
      );
      await waitSearch(
        'J02.H10',
        product.title,
        (h) => h[0]?.inStock === false,
        'sold out',
      );
      const wire = () =>
        receiver.received.map((r) => `${r.id}:${r.replay}`).sort();
      const before = wire();
      const hits = await searchFor(product.title);
      const since = new Date(Date.now() - 15 * 60_000);
      for (const group of [
        'webhook-router',
        'leaderboards',
        'search-product-index',
        'product-cache-invalidator',
      ]) {
        await control.replay(group, since);
        await control.waitCaughtUp(group);
      }
      expect(wire()).toEqual(before);
      expect(await revenueNow(shop)).toBe(rank.revenueMinor);
      expect(await searchFor(product.title)).toEqual(hits);
    });

    it('J02 AS-30: renaming the shop reaches the board with the same rank', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      const { orderId } = await sell([product]);
      await paidAt(orderId);
      await waitRank(shop, (revenue) => revenue >= product.priceMinor);
      const { position } = await waitForContract(
        'J02.H15',
        async () => (await boardEntry(shop.shopId)) ?? null,
        'the shop on the board',
      );
      const name = unique('Renamed');
      const patched = await shop.owner.call(
        'PATCH',
        `/api/shops/${shop.shopId}`,
        {
          body: { name },
        },
      );
      expect(patched.status).toBe(200);
      const after = await waitForContract(
        'J02.H15',
        async () => {
          const found = await boardEntry(shop.shopId);
          return found?.entry.name === name ? found : null;
        },
        'the new name on the board',
      );
      expect(after.position).toBe(position);
    });

    it('J02 AS-31: a declined order is not a sale: no webhook, no rank, the stock comes back', async () => {
      const shop = await readySeller();
      const product = await listed(shop);
      const before = await revenueNow(shop);
      const buyer = await JourneyClient.signUp('buyer');
      const { order } = await checkout(buyer, [{ product, quantity: 1 }]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_declined');
      expect(accepted.status).toBe(202);
      await waitOrderStatus(buyer, order.orderId, 'CANCELLED', 'H11');
      await waitSearch(
        'J02.H10',
        product.title,
        (h) => h[0]?.inStock === true,
        'back in stock',
      );
      await staysTrue(
        'J02.H13',
        async () => {
          expect(
            receiver.ofType('order.paid').some(isOrder(order.orderId)),
          ).toBe(false);
          expect(await revenueNow(shop)).toBe(before);
        },
        'no sale is told',
      );
    });
  });

  describe('US6: every hop is observable', () => {
    it('J02 AS-32: the counters moved, every journey group is at rest and no secret is in the log', async () => {
      const shop = await readySeller();
      const metrics = await readMetrics();
      for (const name of [
        'shops_created_total',
        'onboarding_decisions_total',
        'invoices_paid_total',
        'search_products_indexed_total',
        'webhook_delivery_attempts_total',
        'leaderboard_events_total',
      ])
        expect({ name, moved: metricValue(metrics, name) > 0 }).toEqual({
          name,
          moved: true,
        });
      for (const group of JOURNEY_CONSUMER_GROUPS) {
        const view = await control.waitCaughtUp(group);
        expect(view.state).toBe('RUNNING');
      }
      const log = apiLogPath();
      if (log) {
        const text = logLinesSince(log, 0).join('\n');
        expect(text).not.toContain(receiver.secret);
        expect(text).not.toContain(shop.owner.token!);
      }
    });

    it('J02 AS-33: approved paths only: boundaries, table ownership, module graph and model registry pass', () => {
      const backend = resolve(__dirname, '../..');
      for (const [script, args] of [
        ['check:boundaries', []],
        ['check:table-ownership', ['--strict']],
        ['check:module-graph', []],
        ['check:model-registry', []],
      ] as [string, string[]][]) {
        const r = spawnSync('pnpm', [script, ...args], {
          cwd: backend,
          encoding: 'utf8',
          timeout: 240_000,
        });
        expect([script, r.status, (r.stdout + r.stderr).slice(-600)]).toEqual([
          script,
          0,
          expect.any(String),
        ]);
      }
    }, 600_000);
  });
});
