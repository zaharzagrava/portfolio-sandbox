import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import {
  importJobSchema,
  importStartResponseSchema,
  importUploadStateSchema,
  type ImportStartResponse,
} from '@marketplace-sandbox/contracts';
import { IMPORT_LIMITS } from './domain/import-limits';
import {
  HOUR,
  T,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

const MIB = 1024 * 1024;
const PART = IMPORT_LIMITS.partBytes;

describe('Bulk import upload API', () => {
  let kit: ImportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createImportApp();
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await kit.reset();
  });
  afterEach(async () => {
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const key = () => `key-${randomUUID()}`;
  const base = (s: Seller) => `/api/shops/${s.shop.id}/imports`;
  const start = (
    s: Seller,
    body: unknown,
    idempotencyKey: string | null = key(),
  ) => {
    const req = kit.as(s.owner).post(base(s));
    if (idempotencyKey !== null) req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
  };
  const started = async (
    s: Seller,
    sizeBytes: number,
    fileName = 'catalog.csv',
  ) => {
    const res = await start(s, { fileName, sizeBytes });
    expect(res.status).toBe(201);
    return importStartResponseSchema.parse(res.body);
  };
  const putPart = async (url: string, body: Buffer) => {
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    return res.headers.get('etag')!;
  };
  const complete = (s: Seller, importId: string, parts: unknown) =>
    kit
      .as(s.owner)
      .post(`${base(s)}/${importId}/complete`)
      .send({ parts } as object);
  const jobCount = async (shopId: string) =>
    Number(
      (
        await kit.db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "ImportJob" WHERE "shopId" = :shopId`,
          { type: QueryTypes.SELECT, replacements: { shopId } },
        )
      )[0].n,
    );
  const messages = () =>
    kit.enqueued.filter((m) => m.queue === 'catalog-imports');
  /** A one-part import with its file uploaded, ready for `complete`. */
  const readyToComplete = async (
    s: Seller,
    file = Buffer.from('sku,title,price,category\nA,B,1,c\n'),
  ) => {
    const body = await started(s, file.length);
    const etag = await putPart(body.parts[0].url, file);
    return { body, etag, file };
  };

  describe('start', () => {
    it('S07 AS-01: starting answers 201 with parts to upload, one job row with its history, a server-made key and an open upload', async () => {
      const s = await seller();
      const res = await start(
        s,
        { fileName: 'catalog.csv', sizeBytes: 200_000_000 },
        'k1-start-001',
      );
      expect(res.status).toBe(201);
      const body = importStartResponseSchema.parse(res.body);
      expect(body).toMatchObject({
        status: 'PENDING_UPLOAD',
        partSize: 67_108_864,
        partCount: 3,
      });
      expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(body.uploadExpiresAt).toBe(
        new Date(T.getTime() + 6 * HOUR).toISOString(),
      );

      const job = await kit.job(body.importId);
      expect(job).toMatchObject({
        shopId: s.shop.id,
        createdBy: s.owner.id,
        status: 'PENDING_UPLOAD',
        sizeBytes: 200_000_000,
        fileName: 'catalog.csv',
        slot: 1,
      });
      expect(await kit.history(body.importId)).toEqual([
        { fromStatus: null, toStatus: 'PENDING_UPLOAD', reason: null },
      ]);
      // the key is made by the server from ids only
      expect(job.storageKey).toBe(
        `imports/${s.shop.id}/${body.importId}/source`,
      );
      expect(job.storageKey).not.toContain('catalog');
      // an upload is open in storage: it lists no parts yet, but it exists
      expect(
        await kit.storage.listParts(job.storageKey, job.uploadHandle!),
      ).toEqual([]);
      // every part URL expires six hours after creation and names no file
      for (const part of body.parts) {
        const url = new URL(part.url);
        expect(url.searchParams.get('X-Amz-Expires')).toBe(String(6 * 3600));
        expect(part.url).not.toContain('catalog.csv');
      }
      // the response names no storage key field (the signed part URLs necessarily carry the upload id of the S3 protocol)
      expect(JSON.stringify(res.body)).not.toContain('storageKey');
      expect(Object.keys(res.body).sort()).toEqual([
        'importId',
        'partCount',
        'partSize',
        'parts',
        'status',
        'uploadExpiresAt',
      ]);
    });

    it.each([
      ['sizeBytes 0', { fileName: 'a.csv', sizeBytes: 0 }, 'sizeBytes'],
      ['sizeBytes -1', { fileName: 'a.csv', sizeBytes: -1 }, 'sizeBytes'],
      ['sizeBytes 1.5', { fileName: 'a.csv', sizeBytes: 1.5 }, 'sizeBytes'],
      [
        'sizeBytes as a string',
        { fileName: 'a.csv', sizeBytes: '10' },
        'sizeBytes',
      ],
      [
        'sizeBytes over 5 GiB',
        { fileName: 'a.csv', sizeBytes: 5_368_709_121 },
        'sizeBytes',
      ],
      ['an empty fileName', { fileName: '', sizeBytes: 10 }, 'fileName'],
      [
        'a 201-character fileName',
        { fileName: 'a'.repeat(201), sizeBytes: 10 },
        'fileName',
      ],
      [
        'a control character in fileName',
        { fileName: 'a\u0007b.csv', sizeBytes: 10 },
        'fileName',
      ],
      [
        'an unknown extra field',
        { fileName: 'a.csv', sizeBytes: 10, extra: true },
        'extra',
      ],
      ['no body', undefined, 'fileName'],
    ])(
      'S07 AS-02: %s is 400 validation_failed naming the field, and nothing is created',
      async (_name, body, field) => {
        const s = await seller();
        const res = await start(s, body ?? {});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        expect(JSON.stringify(res.body)).not.toContain('X-Amz');
        expect(await jobCount(s.shop.id)).toBe(0);
      },
    );

    it('S07 AS-02: both size boundaries are inclusive (1 byte is one part, 5 GiB is eighty)', async () => {
      const s = await seller();
      expect((await started(s, 1)).partCount).toBe(1);
      expect((await started(s, 5_368_709_120)).partCount).toBe(80);
    });

    it('S07 AS-03: the same key and body replay the stored answer; one job, one upload', async () => {
      const s = await seller();
      const k = key();
      const first = await start(s, { fileName: 'a.csv', sizeBytes: 100 }, k);
      const second = await start(s, { fileName: 'a.csv', sizeBytes: 100 }, k);
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(await jobCount(s.shop.id)).toBe(1);
    });

    it('S07 AS-04: two identical starts at once make one job; the other answers 409 idempotency_in_flight', async () => {
      const s = await seller();
      // hold the first request inside the storage call so the second arrives while it is in flight
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const reachedPromise = new Promise<void>(
        (resolve) => (reached = resolve),
      );
      const original = kit.storage.startMultipartUpload.bind(kit.storage);
      kit.storage.startMultipartUpload = async (...args) => {
        reached();
        await gate;
        return original(...args);
      };
      try {
        const k = key();
        const first = start(s, { fileName: 'a.csv', sizeBytes: 100 }, k).then(
          (r) => r,
        );
        await reachedPromise;
        const second = await start(s, { fileName: 'a.csv', sizeBytes: 100 }, k);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('idempotency_in_flight');
        release();
        expect((await first).status).toBe(201);
      } finally {
        kit.storage.startMultipartUpload = original;
        release();
      }
      expect(await jobCount(s.shop.id)).toBe(1);
    });

    it('S07 AS-05: another body under the same key is 422 idempotency_key_reuse; no key is 422 idempotency_key_required; a short key is 422 idempotency_key_invalid', async () => {
      const s = await seller();
      const k = key();
      expect(
        (await start(s, { fileName: 'a.csv', sizeBytes: 10 }, k)).status,
      ).toBe(201);
      const reuse = await start(s, { fileName: 'b.csv', sizeBytes: 10 }, k);
      expect(reuse.status).toBe(422);
      expect(reuse.body.code).toBe('idempotency_key_reuse');
      const missing = await start(
        s,
        { fileName: 'a.csv', sizeBytes: 10 },
        null,
      );
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      const short = await start(s, { fileName: 'a.csv', sizeBytes: 10 }, 'k1');
      expect(short.status).toBe(422);
      expect(short.body.code).toBe('idempotency_key_invalid');
      expect(await jobCount(s.shop.id)).toBe(1);
    });
  });

  describe('resume the upload', () => {
    it('S07 AS-06: lists the parts storage holds and signs only the missing ones; another state is 409', async () => {
      const s = await seller();
      const size = 2 * PART + 1000;
      const body = await started(s, size);
      expect(body.partCount).toBe(3);
      const etag1 = await putPart(body.parts[0].url, Buffer.alloc(PART, 1));
      const etag3 = await putPart(body.parts[2].url, Buffer.alloc(1000, 3));

      const res = await kit
        .as(s.owner)
        .get(`${base(s)}/${body.importId}/upload`);
      expect(res.status).toBe(200);
      const state = importUploadStateSchema.parse(res.body);
      expect(state.partCount).toBe(3);
      expect(state.uploaded).toEqual([
        { partNumber: 1, etag: etag1, sizeBytes: PART },
        { partNumber: 3, etag: etag3, sizeBytes: 1000 },
      ]);
      expect(state.missing.map((p) => p.partNumber)).toEqual([2]);
      expect(state.uploadExpiresAt).toBe(
        new Date(T.getTime() + 6 * HOUR).toISOString(),
      );

      // the re-signed part really accepts the middle part, and only that one
      await putPart(state.missing[0].url, Buffer.alloc(PART, 2));

      // any other state refuses
      const cancelled = await kit
        .as(s.owner)
        .post(`${base(s)}/${body.importId}/cancel`);
      expect(cancelled.status).toBe(200);
      const after = await kit
        .as(s.owner)
        .get(`${base(s)}/${body.importId}/upload`);
      expect(after.status).toBe(409);
      expect(after.body.code).toBe('import_not_uploadable');
    }, 120_000);
  });

  describe('complete', () => {
    it('S07 AS-07: complete answers 202 with Location and the UPLOADED job, stores the object at its declared size and enqueues one message', async () => {
      const s = await seller();
      const { body, etag, file } = await readyToComplete(s);
      const res = await complete(s, body.importId, [{ partNumber: 1, etag }]);
      expect(res.status).toBe(202);
      expect(res.headers.location).toBe(`${base(s)}/${body.importId}`);
      const job = importJobSchema.parse(res.body);
      expect(job.status).toBe('UPLOADED');
      const stored = await kit.job(body.importId);
      expect(await kit.storage.head(stored.storageKey)).toMatchObject({
        size: file.length,
      });
      expect(job.history.map((h) => h.status)).toEqual([
        'PENDING_UPLOAD',
        'UPLOADED',
      ]);
      expect(messages()).toEqual([
        {
          queue: 'catalog-imports',
          body: { importId: body.importId },
          options: undefined,
        },
      ]);
      // it did not wait for scanning or parsing
      expect(stored.status).toBe('UPLOADED');
      expect(kit.clamd.connections).toBe(0);
    });

    it.each([
      ['a missing part', [{ partNumber: 1 }, { partNumber: 2 }]],
      [
        'a repeated part',
        [{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 2 }],
      ],
      [
        'parts out of order',
        [{ partNumber: 1 }, { partNumber: 3 }, { partNumber: 2 }],
      ],
      ['part zero', [{ partNumber: 0 }, { partNumber: 1 }, { partNumber: 2 }]],
      [
        'a part beyond the count',
        [
          { partNumber: 1 },
          { partNumber: 2 },
          { partNumber: 3 },
          { partNumber: 4 },
        ],
      ],
      ['an empty list', []],
      [
        'an empty ETag',
        [{ partNumber: 1, etag: '' }, { partNumber: 2 }, { partNumber: 3 }],
      ],
      [
        'an ETag storage does not know',
        [{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 3 }],
      ],
    ])(
      'S07 AS-08: %s is 422 invalid_parts; the job stays PENDING_UPLOAD, nothing is enqueued, the object is not assembled',
      async (_name, shape) => {
        const s = await seller();
        const body = await started(s, 2 * PART + 10);
        const parts = shape.map((p) => ({ etag: 'not-an-etag', ...p }));
        const res = await complete(s, body.importId, parts);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid_parts');
        const job = await kit.job(body.importId);
        expect(job.status).toBe('PENDING_UPLOAD');
        expect(messages()).toEqual([]);
        expect(await kit.storage.head(job.storageKey)).toBeNull();
        expect(await kit.history(body.importId)).toHaveLength(1);
      },
    );

    it('S07 AS-09: parts that add up to less than the declared size are 422 size_mismatch; the job is FAILED, the object deleted, nothing enqueued, the event written', async () => {
      const s = await seller();
      const { body, etag } = await readyToComplete(s);
      // declare one byte more than was uploaded (the signed parts cannot be short through honest URLs, D-09)
      await kit.db.query(
        `UPDATE "ImportJob" SET "sizeBytes" = "sizeBytes" + 1 WHERE "id" = :id`,
        {
          replacements: { id: body.importId },
        },
      );
      const res = await complete(s, body.importId, [{ partNumber: 1, etag }]);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('size_mismatch');
      const job = await kit.job(body.importId);
      expect(job).toMatchObject({
        status: 'FAILED',
        failureCode: 'size_mismatch',
      });
      expect(await kit.storage.head(job.storageKey)).toBeNull();
      expect(messages()).toEqual([]);
      const events = await kit.finishedEvents(body.importId);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('catalogsync.import_finished');
      expect(events[0].payload).toMatchObject({
        status: 'FAILED',
        failureCode: 'size_mismatch',
      });
    });

    it('S07 AS-10: completing again answers 200 with the current status, makes no storage call and adds no message', async () => {
      const s = await seller();
      const { body, etag } = await readyToComplete(s);
      expect(
        (await complete(s, body.importId, [{ partNumber: 1, etag }])).status,
      ).toBe(202);
      const completeSpy = jest.spyOn(kit.storage, 'completeMultipartUpload');
      const listSpy = jest.spyOn(kit.storage, 'listParts');
      const headSpy = jest.spyOn(kit.storage, 'head');
      const again = await complete(s, body.importId, [
        { partNumber: 7, etag: 'whatever' },
      ]);
      expect(again.status).toBe(200);
      expect(importJobSchema.parse(again.body).status).toBe('UPLOADED');
      expect(completeSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
      expect(headSpy).not.toHaveBeenCalled();
      expect(messages()).toHaveLength(1);
      completeSpy.mockRestore();
      listSpy.mockRestore();
      headSpy.mockRestore();
    });

    it('S07 AS-11: two completes at once answer 202 and 200; one message, one PENDING_UPLOAD to UPLOADED history row', async () => {
      const s = await seller();
      const { body, etag } = await readyToComplete(s);
      const parts = [{ partNumber: 1, etag }];
      const [a, b] = await Promise.all([
        complete(s, body.importId, parts),
        complete(s, body.importId, parts),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 202]);
      expect(messages()).toHaveLength(1);
      const moves = (await kit.history(body.importId)).filter(
        (h) => h.fromStatus === 'PENDING_UPLOAD' && h.toStatus === 'UPLOADED',
      );
      expect(moves).toHaveLength(1);
    });

    it.each(['CANCELLED', 'EXPIRED'] as const)(
      'S07 AS-12: completing a %s import is 409 import_not_completable and changes nothing',
      async (dead) => {
        const s = await seller();
        const { body, etag } = await readyToComplete(s);
        if (dead === 'CANCELLED')
          expect(
            (await kit.as(s.owner).post(`${base(s)}/${body.importId}/cancel`))
              .status,
          ).toBe(200);
        else {
          kit.clock.advance(25 * HOUR);
          expect(await kit.lifecycle.expirePending()).toEqual({ expired: 1 });
          await kit.reauth(s.owner); // the token expired with the clock
        }
        const before = await kit.history(body.importId);
        const res = await complete(s, body.importId, [{ partNumber: 1, etag }]);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('import_not_completable');
        expect((await kit.job(body.importId)).status).toBe(dead);
        expect(await kit.history(body.importId)).toEqual(before);
        expect(messages()).toEqual([]);
      },
    );
  });
});
