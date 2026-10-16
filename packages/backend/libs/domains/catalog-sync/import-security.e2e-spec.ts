import { Logger } from '@nestjs/common';
import { importJobSchema } from '@marketplace-sandbox/contracts';
import { ConfigRules } from '@app/common/config/config-rules';
import {
  DisabledMalwareScanner,
  MalwareScanner,
} from '@app/infrastructure/antivirus';
import { IMPORT_SCANNER } from './domain/ports';
import {
  catalogCsv,
  createImportApp,
  type ImportKit,
  type Seller,
} from './testing/import-kit';

const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const MIB = 1024 * 1024;

describe('Bulk import file security', () => {
  let kit: ImportKit;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createImportApp({ env: { IMPORT_SCAN_INACTIVITY_MS: '1500' } });
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await kit.reset();
    await kit.clamd.start().catch(() => undefined); // a spec that refused connections brought it back up here
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await kit.forget(shops.splice(0));
  });

  const seller = async (): Promise<Seller> => {
    const s = await kit.seller();
    shops.push(s.shop.id);
    return s;
  };
  const upload = async (s: Seller, file: Buffer, fileName?: string) =>
    kit.uploaded(s, file, { fileName });
  const status = async (s: Seller, id: string) => {
    const res = await kit
      .as(s.owner)
      .get(`/api/shops/${s.shop.id}/imports/${id}`);
    expect(res.status).toBe(200);
    return importJobSchema.parse(res.body);
  };

  it('S07 AS-21: a clean scan moves SCANNING to PROCESSING, stores the verdict and its time, and streams the file instead of buffering it', async () => {
    const s = await seller();
    const file = catalogCsv(1500, { descriptionLength: 1500 }); // ~2.5 MiB in 1,500 rows
    const id = await upload(s, file);
    expect(await kit.deliver(id)).toBe('done');
    const job = await kit.job(id);
    expect(job).toMatchObject({ status: 'DONE', scan: 'clean' });
    expect(job.scannedAt).not.toBeNull();
    const moves = (await kit.history(id)).map(
      (h) => `${h.fromStatus}>${h.toStatus}`,
    );
    expect(moves).toContain('SCANNING>PROCESSING');
    // the scanner saw the whole file in chunks of at most 64 KiB
    expect(kit.clamd.received.length).toBe(file.length);
    expect(Math.max(...kit.clamd.chunkSizes)).toBeLessThanOrEqual(64 * 1024);
  });

  it('S07 AS-21: a scanner that stops reading stops the source: the file is not held in memory', async () => {
    const s = await seller();
    const file = Buffer.concat([catalogCsv(1), Buffer.alloc(24 * MIB, 'x')]);
    const id = await upload(s, file);
    kit.clamd.mode = 'stall-mid';
    kit.clamd.stallAfterBytes = 256 * 1024;
    const run = kit.deliver(id).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const read = kit.probe.sources()[0];
    // the kernel buffers some MiB on loopback; a reader that ignored backpressure would have taken all 24 MiB
    expect(read.delivered()).toBeLessThan(12 * MIB);
    await run;
    expect(read.stream.destroyed).toBe(true);
  }, 30_000);

  it('S07 AS-22: an infected file is FAILED malware_detected with a generic message; the file is deleted, the catalog never called, the signature only in the logs', async () => {
    const s = await seller();
    const file = Buffer.from(`sku,title,price,category\nA,${EICAR},1,c\n`);
    const id = await upload(s, file);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'malware_detected',
    });
    expect(await kit.exists(job.storageKey)).toBe(false);
    expect(kit.catalogCalls()).toEqual([]);

    const view = await status(s, id);
    expect(view.failure).toEqual({
      code: 'malware_detected',
      message: expect.any(String),
      detail: null,
    });
    const events = await kit.finishedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      status: 'FAILED',
      failureCode: 'malware_detected',
    });
    expect(kit.rt.of(id).filter((e) => e.type === 'failed')).toEqual([
      {
        topic: `import:${id}`,
        type: 'failed',
        data: { code: 'malware_detected' },
        replay: true,
      },
    ]);
    // the signature name is in one log line and nowhere in the API, the events or the live channel
    const everywhere = JSON.stringify([view, events, kit.rt.events]);
    expect(everywhere).not.toContain('Eicar');
    expect(JSON.stringify(warn.mock.calls)).toContain('Eicar-Test-Signature');
  });

  it('S07 AS-23: a scanner that refuses connections keeps the job SCANNING on deliveries 1 and 2 and ends it FAILED scan_unavailable on the third; no row is read', async () => {
    const s = await seller();
    const id = await upload(s, catalogCsv(10));
    await kit.clamd.refuse();
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    expect(await kit.job(id)).toMatchObject({
      status: 'SCANNING',
      leaseHolder: null,
    });
    await expect(kit.deliver(id, 2)).rejects.toThrow();
    expect(await kit.job(id)).toMatchObject({
      status: 'SCANNING',
      rowsProcessed: 0,
    });

    // the third delivery records the terminal failure first, then fails so the queue dead-letters the message
    await expect(kit.deliver(id, 3)).rejects.toThrow();
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'scan_unavailable',
    });
    expect(await kit.exists(job.storageKey)).toBe(false);
    expect(kit.catalogCalls()).toEqual([]);
    expect(job.format).toBeNull(); // the file was never opened as rows
    expect((await kit.finishedEvents(id))[0].payload).toMatchObject({
      failureCode: 'scan_unavailable',
    });
    // never PROCESSING
    expect((await kit.history(id)).map((h) => h.toStatus)).not.toContain(
      'PROCESSING',
    );
  });

  it('S07 AS-24: a scanner that goes quiet is abandoned at the inactivity limit and its socket closed; the delivery is treated as unavailable', async () => {
    const s = await seller();
    const id = await upload(s, catalogCsv(10));
    kit.clamd.mode = 'stall';
    const started = Date.now();
    await expect(kit.deliver(id, 1)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kit.clamd.openSockets).toBe(0);
    expect(await kit.job(id)).toMatchObject({ status: 'SCANNING' });
    await expect(kit.deliver(id, 3)).rejects.toThrow();
    expect(await kit.job(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'scan_unavailable',
    });
  }, 30_000);

  it('S07 AS-24: a slow but progressing scan is not cut off', async () => {
    const s = await seller();
    const id = await upload(s, catalogCsv(3000)); // ~250 KiB
    kit.probe.trickle(48 * 1024, 700); // ~6 pieces, 700 ms apart: longer than the 1.5 s limit in all, never quiet for 1.5 s
    expect(await kit.deliver(id)).toBe('done');
    expect(await kit.job(id)).toMatchObject({ status: 'DONE', scan: 'clean' });
  }, 60_000);

  it('S07 AS-26: a zip renamed .csv is FAILED unsupported_file_type, the file is deleted and no row is read', async () => {
    const s = await seller();
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(2000, 7),
    ]);
    const id = await upload(s, zip, 'catalog.csv');
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'unsupported_file_type',
      rowsProcessed: 0,
    });
    expect(await kit.exists(job.storageKey)).toBe(false);
    expect(kit.catalogCalls()).toEqual([]);
  });

  it('S07 AS-27: a traversal in the file name changes no key: the job shows the cleaned name and the object stays under ids', async () => {
    const s = await seller();
    const res = await kit
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/imports`)
      .set('Idempotency-Key', `key-${Date.now()}-trav`)
      .send({ fileName: '../../etc/passwd.csv', sizeBytes: 100 });
    expect(res.status).toBe(201);
    const job = await kit.job(res.body.importId);
    expect(job.fileName).toBe('etcpasswd.csv');
    expect(job.storageKey).toBe(
      `imports/${s.shop.id}/${res.body.importId}/source`,
    );
    expect(JSON.stringify(res.body)).not.toContain('passwd');
  });

  it('S07 AS-28: a 2 MiB JSON line is one row error and the others import', async () => {
    const s = await seller();
    const good = (n: number) =>
      JSON.stringify({
        sku: `J-${n}`,
        title: `T${n}`,
        price: '1.00',
        category: 'c',
      });
    const huge = JSON.stringify({
      sku: 'HUGE',
      title: 'x'.repeat(2 * MIB),
      price: '1',
      category: 'c',
    });
    const id = await upload(
      s,
      Buffer.from([good(1), huge, good(3)].join('\n') + '\n'),
    );
    expect(await kit.deliver(id)).toBe('done');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'DONE',
      rowsProcessed: 3,
      rowsCreated: 2,
      rowsFailed: 1,
    });
    expect([...(await kit.productsOf(s.shop.id)).keys()].sort()).toEqual([
      'J-1',
      'J-3',
    ]);
    const report = await kit.objectText(job.errorReportKey!);
    expect(report.split('\n')[0]).toBe('row,sku,field,code,message');
    expect(report.split('\n')[1].startsWith('2,,,row_too_large,')).toBe(true);
  });

  it('S07 AS-28: an unterminated CSV quote fails the import malformed_file at the record where it started; earlier batches are kept and memory stays flat', async () => {
    const s = await seller();
    const head = catalogCsv(600).toString('utf8');
    const file = Buffer.from(
      head + 'BROKEN,"never closed\n' + 'y'.repeat(3 * MIB) + '\n',
    );
    const id = await upload(s, file);
    expect(await kit.deliver(id)).toBe('failed');
    const job = await kit.job(id);
    expect(job).toMatchObject({
      status: 'FAILED',
      failureCode: 'malformed_file',
      rowsProcessed: 500,
      lastRow: 500,
    });
    expect(job.failureDetail).toContain('601');
    // the oversized record was never read to its end: the stream was destroyed well before 3 MiB past the break
    const read = kit.probe.sources().at(-1)!;
    expect(read.stream.destroyed).toBe(true);
    expect((await kit.productsOf(s.shop.id)).size).toBe(500);
  });

  it('S07 AS-32: outside production the scanner can be disabled explicitly: the job records scan skipped and one warning is logged per job', async () => {
    // the module picks the disabled scanner when the setting is on (as `.env.test` has it); here the adapter is given
    // that scanner, which is what the import sees in such an environment
    const adapter = kit.app.get(IMPORT_SCANNER, {
      strict: false,
    }) as unknown as {
      scanner: MalwareScanner;
    };
    const live = adapter.scanner;
    adapter.scanner = new DisabledMalwareScanner();
    try {
      const s = await seller();
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const id = await upload(s, catalogCsv(5));
      expect(await kit.deliver(id)).toBe('done');
      expect(await kit.job(id)).toMatchObject({
        status: 'DONE',
        scan: 'skipped',
      });
      expect(kit.clamd.connections).toBe(0);
      const skipped = warn.mock.calls.filter((c) =>
        JSON.stringify(c).includes('import.scan_skipped'),
      );
      expect(skipped).toHaveLength(1);
    } finally {
      adapter.scanner = live;
    }
  });

  it('S07 AS-32: production without a scanner fails the configuration rule naming the setting; production with one passes', () => {
    const production = {
      clamav_host: undefined,
      usercontent_origin: 'https://files.example.com',
    };
    const messages = ConfigRules.validate(production, {
      production: true,
    }).join(' ');
    expect(messages).toContain('clamav_host');
    const ok = ConfigRules.validate(
      {
        clamav_host: 'clamav:3310',
        usercontent_origin: 'https://files.example.com',
      },
      { production: true },
    ).filter((m) => m.includes('catalog-sync-import'));
    expect(ok).toEqual([]);
    const disabled = ConfigRules.validate(
      {
        clamav_host: 'clamav:3310',
        media_scanner_disabled: true,
        usercontent_origin: 'https://files.example.com',
      },
      { production: true },
    ).join(' ');
    expect(disabled).toContain('media_scanner_disabled');
  });
});
