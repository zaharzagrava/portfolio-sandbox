import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import {
  importPageSchema,
  importStartResponseSchema,
} from '@marketplace-sandbox/contracts';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

const endOf = (file: Buffer, records: number): number => {
  let seen = 0;
  for (let i = 0; i < file.length; i++)
    if (file[i] === 0x0a && ++seen === records + 1) return i + 1;
  return file.length;
};

const redisTarget = () => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
  return { host: url.hostname, port: Number(url.port || 6379) };
};

describe('Bulk import fairness and limits', () => {
  let kit: ImportKit;
  let proxy: TcpFaultProxy;
  const shops: string[] = [];

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start(redisTarget());
    kit = await createImportApp({
      env: { REDIS_URL: `redis://127.0.0.1:${proxy.port}/0` },
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await kit.forget(shops);
    await kit.close();
    await proxy.close();
  });
  beforeEach(async () => {
    proxy.mode = 'pass';
    await kit.reset();
  });
  afterEach(async () => {
    proxy.mode = 'pass';
    kit.probe.release();
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const base = (s: { shop: { id: string } }) =>
    `/api/shops/${s.shop.id}/imports`;
  const start = (s: Seller, key = `key-${randomUUID()}`) =>
    kit
      .as(s.owner)
      .post(base(s))
      .set('Idempotency-Key', key)
      .send({ fileName: 'a.csv', sizeBytes: 100 });
  const rows = async (shopId: string) =>
    Number(
      (
        await kit.db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "ImportJob" WHERE "shopId" = :shopId`,
          {
            type: QueryTypes.SELECT,
            replacements: { shopId },
          },
        )
      )[0].n,
    );

  it('S07 AS-60: a shop runs one import at a time, in creation order, and another shop is not delayed; a waiting job is handed back with a delay and spends no delivery', async () => {
    const a = await seller();
    const b = await seller();
    const file = catalogCsv(1000);
    const j1 = await kit.uploaded(a, file);
    const j2 = await kit.uploaded(a, catalogCsv(5, { prefix: 'B' }));
    const j3 = await kit.uploaded(b, catalogCsv(5, { prefix: 'C' }));
    const consumer = kit.consumer();

    // the later job cannot overtake the earlier one even before the earlier one starts
    kit.enqueued.length = 0;
    expect(await consumer.process(j2, 1)).toBe('busy');
    kit.enqueued.length = 0;

    // J1 runs (held right after its first batch)
    kit.probe.freezeAfter(endOf(file, 500), { once: true, skip: 2 });
    const running = consumer.process(j1, 1);
    await kit.probe.reached;
    while ((await kit.job(j1)).lastRow !== 500)
      await new Promise((resolve) => setTimeout(resolve, 25));

    // J3 of the other shop runs to the end at once
    expect(await consumer.process(j3, 1)).toBe('done');
    expect(await kit.job(j3)).toMatchObject({ status: 'DONE' });

    // J2 is handed back: a new message with a delay of 60 s plus or minus 20 %, status unchanged, nothing read
    const reads = kit.probe.sources().filter((r) => r.key.includes(j2)).length;
    expect(await consumer.process(j2, 3)).toBe('busy'); // even on its last delivery: the hand back is not a failure
    const handBack = kit.enqueued.find(
      (m) => (m.body as { importId: string }).importId === j2,
    );
    expect(handBack?.queue).toBe('catalog-imports');
    const delay = (handBack?.options as { delaySeconds: number }).delaySeconds;
    expect(delay).toBeGreaterThanOrEqual(48);
    expect(delay).toBeLessThanOrEqual(72);
    expect(await kit.job(j2)).toMatchObject({
      status: 'UPLOADED',
      leaseHolder: null,
    });
    expect(kit.probe.sources().filter((r) => r.key.includes(j2)).length).toBe(
      reads,
    );

    // when J1 is done, J2 runs next
    kit.probe.release();
    expect(await running).toBe('done');
    expect(await consumer.process(j2, 1)).toBe('done');
    expect(await kit.job(j2)).toMatchObject({
      status: 'DONE',
      rowsProcessed: 5,
    });
  }, 90_000);

  it('S07 AS-61: five starts at once make exactly three imports and two 409 too_many_active_imports; a finished import frees a slot', async () => {
    const s = await seller();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => start(s)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409]);
    for (const refused of results.filter((r) => r.status === 409))
      expect(refused.body.code).toBe('too_many_active_imports');
    expect(await rows(s.shop.id)).toBe(3);

    const first = importStartResponseSchema.parse(
      results.find((r) => r.status === 201)!.body,
    );
    expect(
      (await kit.as(s.owner).post(`${base(s)}/${first.importId}/cancel`))
        .status,
    ).toBe(200);
    expect((await start(s)).status).toBe(201);
    expect(await rows(s.shop.id)).toBe(4);
  });

  it('S07 AS-62: the eleventh start within the hour is 429 with Retry-After and creates nothing; reads still work', async () => {
    const s = await seller();
    for (let i = 0; i < 10; i++) {
      const res = await start(s);
      expect([i, res.status]).toEqual([i, 201]);
      expect(
        (await kit.as(s.owner).post(`${base(s)}/${res.body.importId}/cancel`))
          .status,
      ).toBe(200); // frees the slot
    }
    const refused = await start(s);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(await rows(s.shop.id)).toBe(10);
    expect((await kit.as(s.owner).get(base(s))).status).toBe(200);
  }, 60_000);

  it('S07 AS-62: with the limiter store down, starts are refused 503 (fail closed) and reads are unaffected', async () => {
    const s = await seller();
    expect((await kit.as(s.owner).get(base(s))).status).toBe(200); // warm: the grants are cached
    proxy.mode = 'refuse';
    proxy.sever();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = await start(s);
    expect(refused.status).toBe(503);
    expect(await rows(s.shop.id)).toBe(0);
    const read = await kit.as(s.owner).get(base(s));
    expect(read.status).toBe(200);
    expect(importPageSchema.parse(read.body).items).toEqual([]);
    proxy.mode = 'pass';
  }, 60_000);

  it.each([
    ['SUSPENDED', 403, 'shop_suspended'],
    ['DELETING', 409, 'shop_offboarding'],
  ] as const)(
    'S07 AS-63: a %s shop refuses to start, complete or cancel (%i %s); reads still answer 200 and nothing changes',
    async (status, code, problem) => {
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      shops.push(shop.id);
      const s: Seller = { shop: { id: shop.id }, owner };
      const id = await kit.uploaded(s, catalogCsv(5));
      await kit.setShopStatus(shop.id, status);
      await kit.reauth(owner);

      for (const call of [
        start(s),
        kit
          .as(owner)
          .post(`${base(s)}/${id}/complete`)
          .send({ parts: [] }),
        kit.as(owner).post(`${base(s)}/${id}/cancel`),
      ]) {
        const res = await call;
        expect([status, res.status]).toEqual([status, code]);
        expect(res.body.code).toBe(problem);
      }
      expect((await kit.job(id)).status).toBe('UPLOADED');
      expect(await rows(shop.id)).toBe(1);
      expect((await kit.as(owner).get(base(s))).status).toBe(200);
      expect((await kit.as(owner).get(`${base(s)}/${id}`)).status).toBe(200);
    },
  );
});
