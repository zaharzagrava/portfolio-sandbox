import { randomUUID } from 'node:crypto';
import {
  importJobSchema,
  importPageSchema,
  importStartResponseSchema,
} from '@marketplace-sandbox/contracts';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { v7 as uuidv7 } from 'uuid';
import {
  DAY,
  HOUR,
  T,
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

/** A problem body without the fields that differ per request. */
const shape = (body: Record<string, unknown>) => {
  const { requestId: _r, instance: _i, traceId: _t, ...rest } = body;
  return rest;
};

describe('Bulk import status, progress and cancel', () => {
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
  const key = () => `key-${randomUUID()}`;
  /** A PENDING_UPLOAD import made through the API (so storage holds an open upload). */
  const startViaApi = async (s: Seller, sizeBytes = 100) => {
    const res = await kit
      .as(s.owner)
      .post(base(s))
      .set('Idempotency-Key', key())
      .send({ fileName: 'a.csv', sizeBytes });
    expect(res.status).toBe(201);
    return importStartResponseSchema.parse(res.body);
  };
  const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached in time');
  };
  const cancel = (s: Seller, id: string) =>
    kit.as(s.owner).post(`${base(s)}/${id}/cancel`);
  const view = async (s: Seller, id: string) => {
    const res = await kit.as(s.owner).get(`${base(s)}/${id}`);
    expect(res.status).toBe(200);
    return importJobSchema.parse(res.body);
  };

  it('S07 AS-51: the status is the contract shape with exact counters and history, and shows no storage key, handle, URL, lease or signature', async () => {
    const s = await seller();
    const id = await kit.uploaded(s, catalogCsv(30, { bad: [4] }), {
      fileName: 'catalog.csv',
    });
    await kit.deliver(id);
    const res = await kit.as(s.owner).get(`${base(s)}/${id}`);
    expect(res.status).toBe(200);
    const job = importJobSchema.parse(res.body);
    expect(job).toMatchObject({
      id,
      shopId: s.shop.id,
      status: 'DONE',
      fileName: 'catalog.csv',
      rowsProcessed: 30,
      rowsCreated: 29,
      rowsFailed: 1,
      scan: 'clean',
      failure: null,
      errorReport: { available: true, rows: 3 },
      createdBy: s.owner.id,
    });
    expect(job.history.map((h) => h.status)).toEqual([
      'PENDING_UPLOAD',
      'UPLOADED',
      'SCANNING',
      'PROCESSING',
      'DONE',
    ]);
    const text = JSON.stringify(res.body);
    const stored = await kit.job(id);
    for (const secret of [
      stored.storageKey,
      'storageKey',
      'uploadHandle',
      'leaseHolder',
      'leaseExpiresAt',
      'X-Amz',
      'http',
      'slot',
    ])
      expect(text).not.toContain(secret);

    // a failure shows a code and fixed text, never the scanner's signature or the raw error
    const infected = await kit.uploaded(
      s,
      Buffer.from(
        'sku,title,price,category\nA,X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*,1,c\n',
      ),
    );
    await kit.deliver(infected);
    const failed = await view(s, infected);
    expect(failed.failure).toEqual({
      code: 'malware_detected',
      message: expect.any(String),
      detail: null,
    });
    expect(JSON.stringify(failed)).not.toContain('Eicar');
  });

  it("S07 AS-52: another shop's member and a person with no shop get the same 404 on every route, with the same body as for an import that does not exist; nothing changes", async () => {
    const a = await seller();
    const b = await seller();
    const stranger = await kit.newUser();
    const started = await startViaApi(a);
    const ja = started.importId;
    const missing = uuidv7();
    const before = { job: await kit.job(ja), history: await kit.history(ja) };

    type Call = (
      as: Seller['owner'],
      shopId: string,
      id: string,
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
    const routes: Record<string, Call> = {
      'GET job': (u, shop, id) =>
        kit.as(u).get(`/api/shops/${shop}/imports/${id}`),
      'GET upload': (u, shop, id) =>
        kit.as(u).get(`/api/shops/${shop}/imports/${id}/upload`),
      'POST complete': (u, shop, id) =>
        kit
          .as(u)
          .post(`/api/shops/${shop}/imports/${id}/complete`)
          .send({ parts: [] }),
      'POST cancel': (u, shop, id) =>
        kit.as(u).post(`/api/shops/${shop}/imports/${id}/cancel`),
      'GET error-report': (u, shop, id) =>
        kit.as(u).get(`/api/shops/${shop}/imports/${id}/error-report`),
    };
    for (const [name, call] of Object.entries(routes)) {
      // B's member on B's path: the import is not found, exactly as an unknown one is
      const onB = await call(b.owner, b.shop.id, ja);
      const unknownOnB = await call(b.owner, b.shop.id, missing);
      expect([name, onB.status]).toEqual([name, 404]);
      expect(shape(onB.body)).toEqual(shape(unknownOnB.body));
      expect(onB.body.code).toBe('import_not_found');
      // B's member on A's path, and a stranger on either: the tenancy's not-found, the same as for an unknown shop
      const nowhere = await call(b.owner, randomUUID(), ja);
      for (const [who, shop] of [
        ['member of B on A', a.shop.id],
        ['stranger on A', a.shop.id],
        ['stranger on B', b.shop.id],
      ] as const) {
        const res = await call(
          who === 'member of B on A' ? b.owner : stranger,
          shop,
          ja,
        );
        expect([name, who, res.status]).toEqual([name, who, 404]);
        expect(shape(res.body)).toEqual(shape(nowhere.body));
      }
    }
    // the list of B has none of A's imports, and nothing of A changed
    const list = await kit.as(b.owner).get(base(b));
    expect(list.status).toBe(200);
    expect(importPageSchema.parse(list.body).items).toEqual([]);
    expect(await kit.job(ja)).toEqual(before.job);
    expect(await kit.history(ja)).toEqual(before.history);
  });

  it('S07 AS-53: no credentials is 401 on every route; a read-only role reads and cannot write; a malformed import id is 400 without touching the table', async () => {
    const s = await seller();
    const viewer = await kit.member(s.shop.id, 'VIEWER');
    const started = await startViaApi(s);
    const id = started.importId;
    const http = kit.http();
    const anon = [
      http
        .post(base(s))
        .set('Idempotency-Key', key())
        .send({ fileName: 'a.csv', sizeBytes: 10 }),
      http.get(base(s)),
      http.get(`${base(s)}/${id}`),
      http.get(`${base(s)}/${id}/upload`),
      http.post(`${base(s)}/${id}/complete`).send({ parts: [] }),
      http.post(`${base(s)}/${id}/cancel`),
      http.get(`${base(s)}/${id}/error-report`),
    ];
    for (const req of anon) expect((await req).status).toBe(401);

    // a viewer has products.read and not products.write
    expect((await kit.as(viewer).get(base(s))).status).toBe(200);
    expect((await kit.as(viewer).get(`${base(s)}/${id}`)).status).toBe(200);
    expect(
      (await kit.as(viewer).get(`${base(s)}/${id}/error-report`)).status,
    ).toBe(409); // readable; the import is still PENDING_UPLOAD, so the report is not ready (AS-50)
    const before = await kit.history(id);
    const writes = [
      kit
        .as(viewer)
        .post(base(s))
        .set('Idempotency-Key', key())
        .send({ fileName: 'a.csv', sizeBytes: 10 }),
      kit
        .as(viewer)
        .post(`${base(s)}/${id}/complete`)
        .send({ parts: [] }),
      kit.as(viewer).post(`${base(s)}/${id}/cancel`),
      kit.as(viewer).get(`${base(s)}/${id}/upload`),
    ];
    for (const req of writes) expect((await req).status).toBe(403);
    expect(await kit.history(id)).toEqual(before);
    expect((await kit.job(id)).status).toBe('PENDING_UPLOAD');

    // a malformed import id: 400 validation_failed and no statement on the import table
    const { statements, result } = await recordStatements(
      kit.app,
      () => kit.as(s.owner).get(`${base(s)}/not-a-uuid`),
      /"ImportJob"/,
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('validation_failed');
    expect(statements).toEqual([]);
    const post = await recordStatements(
      kit.app,
      () => kit.as(s.owner).post(`${base(s)}/nope/cancel`),
      /"ImportJob"/,
    );
    expect(post.result.status).toBe(400);
    expect(post.statements).toEqual([]);
  });

  it('S07 AS-54: 45 imports with equal instants page as 20, 20, 5 newest first with no repeat or gap; the status filter narrows; a bad limit, status or cursor is 400', async () => {
    const s = await seller();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      if (i % 5 === 0) kit.clock.advance(1000); // equal instants in groups of five
      const id = uuidv7();
      const r = await kit.repo.insertPending({
        id,
        shopId: s.shop.id,
        createdBy: s.owner.id,
        fileName: `f${i}.csv`,
        sizeBytes: 10,
        storageKey: `imports/${s.shop.id}/${id}/source`,
        now: kit.clock.now(),
      });
      if (r.kind !== 'created') throw new Error('cap');
      await kit.repo.transition({
        importId: id,
        shopId: s.shop.id,
        from: 'PENDING_UPLOAD',
        to: i % 3 === 0 ? 'CANCELLED' : i % 3 === 1 ? 'FAILED' : 'EXPIRED',
        failure: i % 3 === 1 ? { code: 'internal_error' } : undefined,
        now: kit.clock.now(),
      });
      ids.push(id);
    }
    await kit.reauth(s.owner);

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await kit
        .as(s.owner)
        .get(
          `${base(s)}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
      expect(res.status).toBe(200);
      const page = importPageSchema.parse(res.body);
      sizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
    expect([...seen].sort()).toEqual([...ids].sort());
    const created = await Promise.all(seen.map((id) => kit.job(id)));
    for (let i = 1; i < created.length; i++) {
      const prev = created[i - 1];
      const cur = created[i];
      expect(
        prev.createdAt.getTime() > cur.createdAt.getTime() ||
          (prev.createdAt.getTime() === cur.createdAt.getTime() &&
            prev.id > cur.id),
      ).toBe(true);
    }

    const filtered = importPageSchema.parse(
      (await kit.as(s.owner).get(`${base(s)}?status=FAILED&limit=100`)).body,
    );
    expect(filtered.items).toHaveLength(15);
    expect(filtered.items.every((i) => i.status === 'FAILED')).toBe(true);
    expect(
      importPageSchema.parse((await kit.as(s.owner).get(base(s))).body).items,
    ).toHaveLength(20); // default limit

    for (const query of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'status=NOPE',
      'cursor=garbage',
      `cursor=${encodeURIComponent(`${seen[0]}.x`)}`,
    ]) {
      const res = await kit.as(s.owner).get(`${base(s)}?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      expect(res.body.code).toBe('validation_failed');
    }
  }, 90_000);

  it('S07 AS-55: members with products.read may follow import:J, nobody else; terminal events are replayable and progress is not; the polled status agrees', async () => {
    const s = await seller();
    const viewer = await kit.member(s.shop.id, 'VIEWER');
    const writer = await kit.member(s.shop.id, 'STAFF');
    const other = await seller();
    const id = await kit.uploaded(s, catalogCsv(1200));
    const registry = kit.app.get(TopicRegistry);
    const topic = `import:${id}`;

    expect(await registry.canSubscribe({ userId: s.owner.id }, topic)).toBe(
      true,
    );
    expect(await registry.canSubscribe({ userId: viewer.id }, topic)).toBe(
      true,
    );
    expect(await registry.canSubscribe({ userId: writer.id }, topic)).toBe(
      true,
    );
    for (const viewerOf of [
      { userId: other.owner.id },
      {},
      { userId: randomUUID() },
    ])
      expect(await registry.canSubscribe(viewerOf, topic)).toBe(false);
    expect(
      await registry.canSubscribe(
        { userId: s.owner.id },
        `import:${randomUUID()}`,
      ),
    ).toBe(false);
    expect(
      await registry.canSubscribe({ userId: s.owner.id }, `job:${id}`),
    ).toBe(false);

    // the creator is removed from the shop: refused at the next subscription
    const removedWriter = await kit
      .as(s.owner)
      .delete(`/api/shops/${s.shop.id}/members/${writer.id}`);
    expect(removedWriter.status).toBeLessThan(300);
    expect(await registry.canSubscribe({ userId: writer.id }, topic)).toBe(
      false,
    );

    await kit.deliver(id);
    const live = kit.rt.of(id);
    expect(live.filter((e) => e.type === 'progress')).toHaveLength(3);
    expect(
      live
        .filter((e) => e.type === 'progress')
        .every((e) => e.replay === false),
    ).toBe(true);
    const terminal = live.at(-1)!;
    expect(terminal).toMatchObject({
      type: 'done',
      replay: true,
      data: { rowsProcessed: 1200, rowsFailed: 0 },
    });
    // polling gives the same facts
    const polled = await view(s, id);
    expect(polled).toMatchObject({
      status: 'DONE',
      rowsProcessed: 1200,
      rowsFailed: 0,
    });
  }, 60_000);

  describe('cancel (AS-56)', () => {
    it('S07 AS-56: a PENDING_UPLOAD import is CANCELLED at once and its open upload is aborted; a repeat answers 200 unchanged', async () => {
      const s = await seller();
      const { importId } = await startViaApi(s);
      const stored = await kit.job(importId);
      const res = await cancel(s, importId);
      expect(res.status).toBe(200);
      expect(importJobSchema.parse(res.body).status).toBe('CANCELLED');
      expect(
        await kit.storage.listParts(stored.storageKey, stored.uploadHandle!),
      ).toBeNull(); // aborted
      const again = await cancel(s, importId);
      expect(again.status).toBe(200);
      expect(importJobSchema.parse(again.body).history).toEqual(
        importJobSchema.parse(res.body).history,
      );
      expect(
        (await kit.history(importId)).filter((h) => h.toStatus === 'CANCELLED'),
      ).toHaveLength(1);
      expect(await kit.finishedEvents(importId)).toHaveLength(1);
    });

    it('S07 AS-56: an UPLOADED import is CANCELLED at once, its file deleted and its queued message becomes a no-op', async () => {
      const s = await seller();
      const id = await kit.uploaded(s, catalogCsv(10));
      const stored = await kit.job(id);
      expect((await cancel(s, id)).status).toBe(200);
      expect(await view(s, id)).toMatchObject({ status: 'CANCELLED' });
      expect(await kit.exists(stored.storageKey)).toBe(false);
      const reads = kit.probe.reads.length;
      expect(await kit.deliver(id)).toBe('final');
      expect(kit.probe.reads.length).toBe(reads);
      expect(kit.catalogCalls()).toEqual([]);
    });

    it('S07 AS-56: a SCANNING import is cancelled before any row is read', async () => {
      const s = await seller();
      const id = await kit.uploaded(s, catalogCsv(50));
      kit.probe.freezeAfter(100, { once: true }); // the scan's own stream is held
      const running = kit.newRunner().handle(id, 1);
      await kit.probe.reached;
      await waitFor(async () => (await kit.job(id)).status === 'SCANNING');
      const res = await cancel(s, id);
      expect(res.status).toBe(200);
      expect(importJobSchema.parse(res.body).status).toBe('SCANNING'); // it stops at its next safe point
      kit.probe.release();
      expect(await running).toBe('cancelled');
      expect(await kit.job(id)).toMatchObject({
        status: 'CANCELLED',
        rowsProcessed: 0,
      });
      expect(kit.catalogCalls()).toEqual([]);
    }, 30_000);

    it('S07 AS-56: a PROCESSING import stops at its next batch boundary, keeps what was written, closes its stream and deletes the file', async () => {
      const s = await seller();
      const file = catalogCsv(2000);
      const id = await kit.uploaded(s, file);
      kit.probe.freezeAfter(endOf(file, 500), { once: true, skip: 2 });
      const running = kit.newRunner().handle(id, 1);
      await kit.probe.reached;
      await waitFor(async () => (await kit.job(id)).lastRow === 500);
      const res = await cancel(s, id);
      expect(res.status).toBe(200);
      expect(importJobSchema.parse(res.body).status).toBe('PROCESSING');
      kit.probe.release();
      expect(await running).toBe('cancelled');
      const job = await kit.job(id);
      // batch 2 was in the air when the request came: it is written and counted, then the run stops
      expect(job).toMatchObject({
        status: 'CANCELLED',
        lastRow: 1000,
        rowsProcessed: 1000,
        rowsCreated: 1000,
      });
      expect((await kit.productsOf(s.shop.id)).size).toBe(1000);
      expect(await kit.exists(job.storageKey)).toBe(false);
      expect(kit.probe.sources().at(-1)!.stream.destroyed).toBe(true);
      expect(kit.rt.of(id).at(-1)).toMatchObject({
        type: 'cancelled',
        replay: true,
      });
      expect(await kit.finishedEvents(id)).toHaveLength(1);
    }, 60_000);

    it.each(['DONE', 'FAILED', 'EXPIRED'] as const)(
      'S07 AS-56: cancelling a %s import is 409 import_not_cancellable',
      async (final) => {
        const s = await seller();
        let id: string;
        if (final === 'DONE') {
          id = await kit.uploaded(s, catalogCsv(5));
          await kit.deliver(id);
        } else if (final === 'FAILED') {
          id = await kit.uploaded(s, Buffer.from('sku,title\nA,B\n'));
          await kit.deliver(id);
        } else {
          id = (await startViaApi(s)).importId;
          kit.clock.advance(25 * HOUR);
          await kit.lifecycle.expirePending();
          await kit.reauth(s.owner);
        }
        const before = await kit.history(id);
        const res = await cancel(s, id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('import_not_cancellable');
        expect((await kit.job(id)).status).toBe(final);
        expect(await kit.history(id)).toEqual(before);
      },
    );
  });

  it('S07 AS-57: complete and cancel at once make one outcome: the loser answers 409, and the state agrees with the winner', async () => {
    const s = await seller();
    const started = await startViaApi(s);
    const stored = await kit.job(started.importId);
    const file = Buffer.from('sku,title,price,category\nA,B,1,c\n');
    await kit.db.query(
      `UPDATE "ImportJob" SET "sizeBytes" = :size WHERE "id" = :id`,
      {
        replacements: { size: file.length, id: started.importId },
      },
    );
    // re-sign the single part for the real length
    const state = await kit
      .as(s.owner)
      .get(`${base(s)}/${started.importId}/upload`);
    const put = await fetch(state.body.missing[0].url, {
      method: 'PUT',
      body: new Uint8Array(file),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!;

    const [done, gone] = await Promise.all([
      kit
        .as(s.owner)
        .post(`${base(s)}/${started.importId}/complete`)
        .send({ parts: [{ partNumber: 1, etag }] }),
      cancel(s, started.importId),
    ]);
    const final = await kit.job(started.importId);
    const messages = kit.enqueued.filter((m) => m.queue === 'catalog-imports');
    const transitions = (await kit.history(started.importId))
      .slice(1)
      .map((h) => h.toStatus);
    if (done.status === 202 && gone.status === 409) {
      expect(gone.body.code).toBe('import_not_cancellable');
      expect(final.status).toBe('UPLOADED');
      expect(messages).toHaveLength(1);
      expect(transitions).toEqual(['UPLOADED']);
    } else if (done.status === 409 && gone.status === 200) {
      expect(done.body.code).toBe('import_not_completable');
      expect(final.status).toBe('CANCELLED');
      expect(messages).toHaveLength(0);
      expect(
        await kit.storage.listParts(stored.storageKey, stored.uploadHandle!),
      ).toBeNull();
      expect(transitions).toEqual(['CANCELLED']);
    } else {
      // complete won first and the cancel then found the import UPLOADED: a cancel from there is allowed (AS-56)
      expect([done.status, gone.status]).toEqual([202, 200]);
      expect(final.status).toBe('CANCELLED');
      expect(transitions).toEqual(['UPLOADED', 'CANCELLED']);
    }
  }, 30_000);

  it('S07 AS-59: uploads left for more than 24 hours expire once, with the upload aborted and one event; younger ones are untouched, on one instance or two', async () => {
    const s = await seller();
    const open = async (age: number) => {
      const id = uuidv7();
      const r = await kit.repo.insertPending({
        id,
        shopId: s.shop.id,
        createdBy: s.owner.id,
        fileName: 'a.csv',
        sizeBytes: 10,
        storageKey: `imports/${s.shop.id}/${id}/source`,
        now: new Date(T.getTime() - age),
      });
      if (r.kind !== 'created') throw new Error('cap');
      const key = `imports/${s.shop.id}/${id}/source`;
      const { uploadHandle } = await kit.importStorage.startUpload(key);
      await kit.repo.setUploadHandle(id, s.shop.id, uploadHandle, T);
      return { id, key, handle: uploadHandle };
    };
    const old = await open(25 * HOUR);
    const young = await open(23 * HOUR);

    const [r1, r2] = await Promise.all([
      kit.lifecycle.expirePending(),
      kit.lifecycle.expirePending(),
    ]);
    expect(r1.expired + r2.expired).toBe(1);
    expect(await kit.job(old.id)).toMatchObject({
      status: 'EXPIRED',
      uploadHandle: null,
    });
    expect(await kit.storage.listParts(old.key, old.handle)).toBeNull();
    expect((await kit.finishedEvents(old.id))[0].payload).toMatchObject({
      status: 'EXPIRED',
    });
    expect(await kit.job(young.id)).toMatchObject({ status: 'PENDING_UPLOAD' });
    expect(await kit.storage.listParts(young.key, young.handle)).toEqual([]);

    // a second run changes nothing
    expect(await kit.lifecycle.expirePending()).toEqual({ expired: 0 });
    expect(await kit.finishedEvents(old.id)).toHaveLength(1);
    // and an expired import cannot be completed
    const res = await kit
      .as(s.owner)
      .post(`${base(s)}/${old.id}/complete`)
      .send({ parts: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('import_not_completable');
    void DAY;
  });
});
