import { createShop } from '@app/test/utils/tenancy-fixtures';
import { ShopBatchReadModule } from './batch-read.module';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

describe('Public batch read of shops', () => {
  let t: TenancyTestApp;

  beforeAll(async () => {
    t = await createTenancyApp({ extraImports: [ShopBatchReadModule] });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-80: answers {id, name, slug} or null in request order, anonymously and cacheable', async () => {
    const owner = await t.newUser();
    const a = await createShop(t.app, owner, { name: 'Alpha', slug: 'alpha' });
    const b = await createShop(t.app, owner, { name: 'Beta', slug: 'beta' });
    const unknown = '018f0000-0000-7000-8000-000000000000';

    const res = await t
      .http()
      .get(`/api/batch/shops?ids=${b.id},${unknown},${a.id}`)
      .expect(200);
    expect(res.body).toEqual([
      { id: b.id, name: 'Beta', slug: 'beta' },
      null,
      { id: a.id, name: 'Alpha', slug: 'alpha' },
    ]);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  it('S03 AS-80: sandbox, suspended, closing and deleted shops are null', async () => {
    const owner = await t.newUser();
    const live = await createShop(t.app, owner, { slug: 'live' });
    const sandbox = await createShop(t.app, null, {
      slug: 'live-sandbox',
      sandboxOf: live.id,
    });
    const suspended = await createShop(t.app, owner, {
      slug: 'susp',
      status: 'SUSPENDED',
    });
    const closing = await createShop(t.app, owner, {
      slug: 'closing',
      status: 'DELETING',
    });
    const deleted = await createShop(t.app, owner, {
      slug: 'deleted-abc',
      status: 'DELETED',
    });
    const res = await t
      .http()
      .get(
        `/api/batch/shops?ids=${[live, sandbox, suspended, closing, deleted].map((s) => s.id).join(',')}`,
      )
      .expect(200);
    expect(
      res.body.map((r: { slug: string } | null) => r?.slug ?? null),
    ).toEqual(['live', null, null, null, null]);
    expect(JSON.stringify(res.body)).not.toMatch(/plan|stripe|status/i);
  });

  it('S03 AS-80: more than 100 ids or a malformed id is 400 validation_failed', async () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `018f0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const tooMany = await t
      .http()
      .get(`/api/batch/shops?ids=${many.join(',')}`)
      .expect(400);
    expect(tooMany.body.code).toBe('validation_failed');
    const malformed = await t
      .http()
      .get('/api/batch/shops?ids=not-an-id')
      .expect(400);
    expect(malformed.body.code).toBe('validation_failed');
    await t
      .http()
      .get(`/api/batch/shops?ids=${many.slice(0, 100).join(',')}`)
      .expect(200);
  });
});
