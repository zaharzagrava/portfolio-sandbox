import { linkStatsSchema } from '@marketplace-sandbox/contracts';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

/** The end-to-end smoke of the whole feature; the detailed scenarios live in the share-links-*.e2e-spec.ts files. */
describe('Share links: the share journey (API half)', () => {
  let t: ShareLinksTestApp;
  let u1: TestUser;

  beforeAll(async () => {
    t = await createShareLinksApp({ consumer: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    u1 = await t.user();
  });

  // The "Share" button and copy control belong to W02; they are a row in specs/UNVERIFIED.md.
  it('S37 AS-66: a signed-in buyer creates a link, a visitor without a session lands on the product with ?ref=<code>, and the owner sees the click', async () => {
    const destination = t.destination('/p/shared-product');
    const code = await t.newLink(u1, { destination });

    const res = await t.follow(code);

    expect(res.status).toBe(302);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.location).toBe(`${destination}?ref=${code}`);
    await waitFor(async () => t.eventsFor(code)[0]);
    // the Kafka hop is a spy in this fixture: hand the published event to the real consumer
    await t.deliver([t.eventsFor(code)[0].value], code);
    const total = await waitFor(
      async () => {
        const body = (await t.as(u1).get(`/api/links/${code}/stats?range=24h`))
          .body;
        const parsed = linkStatsSchema.parse(body);
        return parsed.total > 0 ? parsed.total : null;
      },
      {
        description: `a click in the statistics of ${code}`,
        timeoutMs: 30_000,
      },
    );
    expect(total).toBe(1);
  });

  it('smoke: create answers 201 with a 7-character code and the redirect carries the exact cache header and an empty body', async () => {
    const created = await t.create(u1, {
      destination: t.destination('/p/iphone-17?color=blue'),
    });
    expect(created.status).toBe(201);
    const code = created.body.code as string;
    expect(code).toMatch(/^[0-9A-Za-z]{7}$/);

    const res = await t.follow(code);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${t.destination('/p/iphone-17?color=blue')}&ref=${code}`,
    );
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=10');
    expect(res.text).toBe('');
  });

  it('smoke: a click the edge already counted is not counted again here', async () => {
    const code = await t.newLink(u1);
    const res = await t.follow(code, {
      'x-edge-click-recorded': '1',
      'x-edge-credential': t.config.get('share_link_edge_secret'),
    });
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.eventsFor(code)).toHaveLength(0);
    expect(t.published).toEqual([]);
  });

  it('smoke: ten concurrent claims of one alias leave exactly one owner', async () => {
    const alias = t.alias('drop');
    const results = await inParallel(10, () =>
      t.create(u1, { destination: t.destination('/drops/sneakers'), alias }),
    );
    const statuses = results.map(
      (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201 && s !== 409)).toEqual([]);
    expect((await t.follow(alias)).status).toBe(302);
  });

  it('smoke: unknown codes answer 404 and destinations outside the marketplace are rejected', async () => {
    expect((await t.follow('Zz9Zz9Z')).status).toBe(404);
    for (const destination of [
      'https://evil.example/phish',
      'javascript:alert(1)',
    ]) {
      const res = await t.create(u1, { destination });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain('evil');
    }
  });

  it('smoke: an alias that was looked up before it existed answers 302 as soon as it is claimed', async () => {
    const alias = t.alias('late');
    expect((await t.follow(alias)).status).toBe(404);
    expect(
      (await t.create(u1, { destination: t.destination('/p/y'), alias }))
        .status,
    ).toBe(201);
    expect((await t.follow(alias)).status).toBe(302);
  });
});
