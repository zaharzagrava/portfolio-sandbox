import { createHash, randomInt, randomUUID } from 'node:crypto';
import { minimalPdf } from '../../utils/minimal-pdf';
import { waitFor } from '../../utils/async-helpers';
import { JourneyClient, problemCode, unique } from './journey-client';
import { resetRateLimits } from './rate-limits';

export interface ProductSpec {
  title?: string;
  priceMinor: number;
  quantity: number;
  category?: string;
}

export interface FixtureProduct {
  id: string;
  title: string;
  priceMinor: number;
}

export interface SellerFixture {
  owner: JourneyClient;
  /** Present when `staff: true`: a member with role STAFF (receives no sale notices). */
  staff?: JourneyClient;
  shopId: string;
  slug: string;
  products: FixtureProduct[];
}

export interface SellerOptions {
  products: ProductSpec[];
  staff?: boolean;
  /** Operator-set payout destination (`PUT /finance/shops/:id/payout-destination`); omitted = none. */
  destination?: 'acct_test_ok' | 'acct_test_reject' | 'acct_test_timeout';
}

/** IBAN (DE) with a valid check digit from a random account number: every shop gets its own, so no cross-shop duplicate rule fires. */
export function randomIban(): string {
  const bban = '37040044' + String(randomInt(0, 1e10)).padStart(10, '0');
  const rearranged = BigInt(
    [...(bban + 'DE00')]
      .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
      .join(''),
  );
  const check = String(BigInt(98) - (rearranged % BigInt(97))).padStart(2, '0');
  return `DE${check}${bban}`;
}

const recent = () =>
  new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
const field = (value: string) => ({
  value,
  confidence: 'high',
  evidence: value,
});

/**
 * A PDF whose bytes carry the answer the keyless local extractor must give (`SCRIPTED-REPLY:` marker, see the scripted LLM
 * provider): the stack has no model, and the journey may not reach into the process to script one.
 */
function document(page: string, reply: Record<string, unknown>): Buffer {
  const pdf = minimalPdf([[page, randomUUID()]]);
  return Buffer.concat([
    pdf,
    Buffer.from(`\n%SCRIPTED-REPLY:${JSON.stringify(reply)}\n`, 'latin1'),
  ]);
}

export async function upload(
  owner: JourneyClient,
  shopId: string,
  kind: string,
  bytes: Buffer,
): Promise<void> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const requested = await owner.post<{
    document: { id: string };
    upload: { url: string; headers: Record<string, string> } | null;
  }>(`/api/shops/${shopId}/onboarding/documents`, {
    body: { kind, sha256, size: bytes.length, contentType: 'application/pdf' },
  });
  if (requested.status !== 201)
    throw new Error(
      `request upload ${kind}: ${requested.status} ${JSON.stringify(requested.body)}`,
    );
  if (requested.body.upload) {
    const put = await fetch(requested.body.upload.url, {
      method: 'PUT',
      headers: requested.body.upload.headers,
      body: new Uint8Array(bytes),
    });
    if (!put.ok) throw new Error(`put ${kind}: ${put.status}`);
  }
  const done = await owner.post(
    `/api/shops/${shopId}/onboarding/documents/${requested.body.document.id}/uploaded`,
  );
  if (done.status !== 200)
    throw new Error(
      `uploaded ${kind}: ${done.status} ${JSON.stringify(done.body)}`,
    );
}

/** Drives S04 to a verified, payout-enabled shop through public routes only (the extractor double reads the marker). */
async function verifyShop(owner: JourneyClient, shopId: string): Promise<void> {
  const number = await answerAndSubmit(owner, shopId);
  await uploadOkDocuments(owner, shopId, number);
  await waitVerified(owner, shopId);
}

/** Saves the four questionnaire steps and submits; returns the registration number the documents must carry. */
export async function answerAndSubmit(
  owner: JourneyClient,
  shopId: string,
): Promise<string> {
  const number = String(randomInt(10_000, 99_999));
  const steps: Record<string, unknown> = {
    business: {
      legalForm: 'LIMITED_COMPANY',
      businessName: 'Muller Handels',
      country: 'DE',
      registrationNumber: `HRB ${number}`,
    },
    tax: { vatRegistered: false, vatNumber: null },
    catalog: {
      categories: ['Phones', 'Accessories'],
      expectedMonthlyOrders: 'UNDER_1000',
    },
    policies: { returnsDays: 30, shipsFrom: 'DE' },
  };
  for (const [step, body] of Object.entries(steps)) {
    const saved = await owner.put(
      `/api/shops/${shopId}/onboarding/steps/${step}`,
      { body },
    );
    if (saved.status !== 200)
      throw new Error(
        `onboarding step ${step}: ${saved.status} ${JSON.stringify(saved.body)}`,
      );
  }
  const submitted = await owner.post(`/api/shops/${shopId}/onboarding/submit`);
  if (submitted.status !== 200)
    throw new Error(
      `onboarding submit: ${submitted.status} ${JSON.stringify(submitted.body)}`,
    );
  return number;
}

/** The two documents a non-VAT business needs, with the scripted replies the model double reads. */
export async function uploadOkDocuments(
  owner: JourneyClient,
  shopId: string,
  number: string,
): Promise<void> {
  await upload(
    owner,
    shopId,
    'BUSINESS_REGISTRATION',
    document('Business registration', {
      documentType: 'BUSINESS_REGISTRATION',
      legible: true,
      fields: {
        legalName: field('Müller Handels GmbH'),
        registrationNumber: field(`HRB${number}`),
        country: field('DE'),
        registeredAddress: field('Hauptstr. 1, Berlin'),
        issueDate: field('2020-01-15'),
      },
    }),
  );
  await upload(
    owner,
    shopId,
    'BANK_STATEMENT',
    document('Bank statement', {
      documentType: 'BANK_STATEMENT',
      legible: true,
      fields: {
        accountHolder: field('Müller Handels GmbH'),
        iban: field(randomIban()),
        bankName: field('Commerzbank'),
        statementDate: field(recent()),
      },
    }),
  );
}

export async function waitVerified(
  owner: JourneyClient,
  shopId: string,
): Promise<void> {
  try {
    await waitFor(
      async () => {
        const shop = await owner.get<{ verificationStatus?: string }>(
          `/api/shops/${shopId}`,
        );
        return (
          shop.status === 200 && shop.body.verificationStatus === 'VERIFIED'
        );
      },
      {
        timeoutMs: 60_000,
        intervalMs: 500,
        description: `shop ${shopId} VERIFIED by the onboarding extraction`,
      },
    );
  } catch (error) {
    const [shop, onboarding] = await Promise.all([
      owner.get(`/api/shops/${shopId}`),
      owner.get(`/api/shops/${shopId}/onboarding`),
    ]);
    throw new Error(
      `${(error as Error).message}\nshop: ${JSON.stringify(shop.body)}\nonboarding: ${JSON.stringify(onboarding.body)}`,
    );
  }
}

async function createShop(
  owner: JourneyClient,
): Promise<{ shopId: string; slug: string }> {
  const slug = unique('j01');
  const created = await owner.post<{ id: string }>('/api/shops', {
    body: { name: `Journey ${slug}`, slug },
  });
  if (created.status === 201) return { shopId: created.body.id, slug };
  // L-010: creating on first use is idempotent; a second attempt (a retried hook) opens the shop that exists.
  if (created.status === 409) {
    const mine = await owner.get<{ items?: { id: string; slug: string }[] }>(
      '/api/shops/mine',
    );
    const existing = mine.body.items?.[0];
    if (existing) return { shopId: existing.id, slug: existing.slug };
  }
  throw new Error(
    `create shop: ${created.status} ${problemCode(created.body)} ${JSON.stringify(created.body)}`,
  );
}

async function addStaff(
  owner: JourneyClient,
  shopId: string,
): Promise<JourneyClient> {
  const staff = await JourneyClient.signUp('staff');
  await inviteAndAccept(owner, shopId, staff);
  return staff;
}

/** Invites an existing account to the shop as STAFF through the public routes and accepts from the dev mailbox. */
export async function inviteAndAccept(
  owner: JourneyClient,
  shopId: string,
  staff: JourneyClient,
  role: 'ADMIN' | 'STAFF' | 'VIEWER' = 'STAFF',
): Promise<void> {
  const invited = await owner.post(`/api/shops/${shopId}/invites`, {
    body: { email: staff.email, role },
  });
  if (invited.status !== 201)
    throw new Error(
      `invite staff: ${invited.status} ${JSON.stringify(invited.body)}`,
    );
  const token = await waitFor(
    async () => {
      const mailbox = await fetch(
        `${process.env.API_URL ?? 'http://localhost:8000'}/api/dev/mailbox?to=${encodeURIComponent(staff.email)}`,
      );
      if (!mailbox.ok) return null;
      const { messages } = (await mailbox.json()) as {
        messages: { links: string[] }[];
      };
      const link = messages
        .flatMap((m) => m.links)
        .find((l) => l.includes('/invites/'));
      return link
        ? decodeURIComponent(new URL(link).pathname.split('/invites/')[1])
        : null;
    },
    {
      timeoutMs: 15_000,
      intervalMs: 250,
      description: 'the invite e-mail in the dev mailbox',
    },
  );
  const accepted = await staff.post('/api/shop-invites/accept', {
    body: { token },
  });
  if (accepted.status !== 201 && accepted.status !== 200)
    throw new Error(
      `accept invite: ${accepted.status} ${JSON.stringify(accepted.body)}`,
    );
}

async function addProduct(
  owner: JourneyClient,
  shopId: string,
  spec: ProductSpec,
): Promise<FixtureProduct> {
  const title = spec.title ?? unique('J01 Item');
  const created = await owner.post<{ id: string }>(
    `/api/shops/${shopId}/products`,
    {
      body: {
        title,
        brand: 'Journey',
        category: spec.category ?? 'electronics',
        quantity: spec.quantity,
        priceMinor: spec.priceMinor,
        description: `${title}. Created by the J01 journey.`,
        tags: ['journey'],
      },
    },
  );
  if (created.status !== 201)
    throw new Error(
      `create product: ${created.status} ${JSON.stringify(created.body)}`,
    );
  return { id: created.body.id, title, priceMinor: spec.priceMinor };
}

/** Sets the payout destination as the operator. The cooling period of S15 is crossed by the journey through the clock. */
export async function setDestination(
  admin: JourneyClient,
  shopId: string,
  providerAccountId: string,
): Promise<void> {
  const reply = await admin.put(
    `/api/finance/shops/${shopId}/payout-destination`,
    { body: { providerAccountId }, key: randomUUID() },
  );
  if (reply.status !== 200)
    throw new Error(
      `payout destination: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
}

/** A new owner (and optionally staff), a verified shop, products with stock, an optional payout destination. Own data per call (L-005, L-006). */
export async function createSeller(
  admin: JourneyClient,
  options: SellerOptions,
): Promise<SellerFixture> {
  const owner = await JourneyClient.signUp('owner');
  await resetRateLimits(); // shop creation has its own hourly limit
  const { shopId, slug } = await createShop(owner);
  await verifyShop(owner, shopId);
  const staff = options.staff ? await addStaff(owner, shopId) : undefined;
  const products: FixtureProduct[] = [];
  for (const spec of options.products)
    products.push(await addProduct(owner, shopId, spec));
  if (options.destination)
    await setDestination(admin, shopId, options.destination);
  return { owner, staff, shopId, slug, products };
}

/** Current stock of a product, read through the catalog's own member API. */
export async function stockOf(
  seller: SellerFixture,
  productId: string,
): Promise<number> {
  const reply = await seller.owner.get<{ quantity: number }>(
    `/api/shops/${seller.shopId}/products/${productId}`,
  );
  if (reply.status !== 200)
    throw new Error(
      `stock of ${productId}: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return reply.body.quantity;
}

// --- J02: the seller's own path, step by step (each step idempotent: a retried hook opens what exists, L-010) ------------

export interface OpenShop {
  owner: JourneyClient;
  shopId: string;
  slug: string;
}

/** A brand-new account (`202` then sign-in). The role stays `USER` until the shop exists and identity's consumer ran. */
export const registerSeller = (label = 'seller'): Promise<JourneyClient> =>
  JourneyClient.signUp(label);

/** `POST /shops` with its own idempotency key; a retry with the same owner opens the shop that exists. */
export async function openShop(
  owner: JourneyClient,
  key: string = randomUUID(),
): Promise<OpenShop> {
  await resetRateLimits();
  const slug = unique('j02');
  const created = await owner.post<{ id: string }>('/api/shops', {
    body: { name: `Journey ${slug}`, slug },
    key,
  });
  if (created.status === 201 || created.status === 200)
    return { owner, shopId: created.body.id, slug };
  if (created.status === 409) {
    const mine = await owner.get<{ items?: { id: string; slug: string }[] }>(
      '/api/shops/mine',
    );
    const existing = mine.body.items?.[0];
    if (existing) return { owner, shopId: existing.id, slug: existing.slug };
  }
  throw new Error(
    `create shop: ${created.status} ${problemCode(created.body)} ${JSON.stringify(created.body)}`,
  );
}

/** The ok path of S04 (questionnaire, submit, `kyc-ok-*` documents) to a `VERIFIED`, payout-enabled shop. */
export async function onboardVerified(shop: OpenShop): Promise<void> {
  await verifyShop(shop.owner, shop.shopId);
}

/** The public price of the shop plan `code` (default `pro`), read from the anonymous catalog. */
export async function shopPriceId(
  owner: JourneyClient,
  code = 'pro',
  interval: 'MONTH' | 'YEAR' = 'MONTH',
): Promise<{ priceId: string; maxProducts: number | null }> {
  const catalog = await owner.get<{
    plans: {
      code: string;
      audience: string;
      entitlements: Record<string, number | boolean>;
      prices: { id: string; interval: string }[];
    }[];
  }>('/api/plans');
  const plan = catalog.body.plans.find(
    (p) => p.code === code && p.audience === 'SHOP',
  );
  const price = plan?.prices.find((p) => p.interval === interval);
  if (!plan || !price)
    throw new Error(`no ${code}/${interval} shop price in /plans`);
  const max = plan.entitlements.maxProducts;
  return {
    priceId: price.id,
    maxProducts: typeof max === 'number' ? max : null,
  };
}

/** `POST /shops/:id/subscription` with a key; `pm` is a scripted payment method (`pm_test_visa`, `pm_test_declined`). */
export async function subscribe(
  shop: OpenShop,
  pm = 'pm_test_visa',
  options: { code?: string; key?: string } = {},
) {
  const { priceId } = await shopPriceId(shop.owner, options.code);
  return shop.owner.post<Record<string, any>>(
    `/api/shops/${shop.shopId}/subscription`,
    {
      body: { priceId, paymentMethodRef: pm },
      key: options.key ?? randomUUID(),
    },
  );
}

/** Creates a product through the seller route; `overrides` replace any field of the body. */
export async function createProduct(
  shop: OpenShop,
  overrides: Record<string, unknown> = {},
  key: string = randomUUID(),
) {
  const title = (overrides.title as string | undefined) ?? unique('J02 Item');
  return shop.owner.post<Record<string, any>>(
    `/api/shops/${shop.shopId}/products`,
    {
      body: {
        title,
        brand: 'Journey',
        category: 'electronics',
        quantity: 1,
        priceMinor: 1500,
        currency: 'EUR',
        description: `${title}. Created by the J02 journey.`,
        tags: ['journey'],
        ...overrides,
      },
      key,
    },
  );
}

/** Creates a webhook endpoint for `url`; the secret comes back once, in this reply. */
export async function createEndpoint(
  shop: OpenShop,
  url: string,
  events: string[] = ['order.paid'],
) {
  return shop.owner.post<{ id: string; secret: string }>(
    `/api/shops/${shop.shopId}/developers/webhooks`,
    { body: { url, events } },
  );
}
