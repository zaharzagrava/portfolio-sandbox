import { PassThrough, Readable } from 'node:stream';
import { ClamdMalwareScanner, scanStream } from './clamd-scanner';
import { DisabledMalwareScanner } from './disabled-scanner';
import { FakeMalwareScanner } from './fake-scanner';
import { ScannerUnavailableError } from './malware-scanner';
import { FakeClamd } from './testing/fake-clamd';

const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** A source of `total` bytes in 64 KiB pieces; `pulled()` says how many bytes the reader has taken. */
const bigSource = (total: number) => {
  let pulled = 0;
  const source = Readable.from(
    (function* () {
      for (let at = 0; at < total; at += 65_536) {
        const piece = Buffer.alloc(Math.min(65_536, total - at), 97);
        pulled += piece.length;
        yield piece;
      }
    })(),
  );
  return { source, pulled: () => pulled };
};

/** `pieces` pieces of 1 KiB, `gapMs` apart. */
const trickle = (pieces: number, gapMs: number) =>
  Readable.from(
    (async function* () {
      for (let i = 0; i < pieces; i++) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        yield Buffer.alloc(1024, 97);
      }
    })(),
  );

describe('S07 clamd streaming protocol (AS-25)', () => {
  const clamd = new FakeClamd();
  let port: number;

  beforeAll(async () => {
    port = await clamd.start();
  });
  afterAll(() => clamd.stop());
  beforeEach(() => clamd.reset());

  const scan = (
    source: Readable,
    options: { timeoutMs: number; inactivityMs?: number } = {
      timeoutMs: 5_000,
    },
  ) => new ClamdMalwareScanner('127.0.0.1', port).scan(source, options);

  it('S07 AS-25: stream: OK is clean, and the content arrives in length-prefixed chunks of at most 64 KiB', async () => {
    const file = Buffer.alloc(300_000, 'a');
    await expect(
      scan(Readable.from([file.subarray(0, 100_000), file.subarray(100_000)])),
    ).resolves.toEqual({ clean: true });
    expect(clamd.commands).toEqual(['zINSTREAM']);
    expect(clamd.received.equals(file)).toBe(true);
    expect(Math.max(...clamd.chunkSizes)).toBeLessThanOrEqual(65_536);
    expect(clamd.chunkSizes.reduce((a, b) => a + b, 0)).toBe(300_000);
  });

  it('S07 AS-25: stream: <signature> FOUND is infected with the signature', async () => {
    await expect(scan(Readable.from([Buffer.from(EICAR)]))).resolves.toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
  });

  it.each([
    ['an INSTREAM size limit reply', 'size-limit'],
    ['an empty reply', 'empty'],
    ['a half-written reply', 'partial'],
    ['any other text', 'garbage'],
  ] as const)(
    'S07 AS-25: %s throws, so the job fails closed',
    async (_name, mode) => {
      clamd.mode = mode;
      clamd.limitBytes = 100_000;
      await expect(scan(bigSource(400_000).source)).rejects.toBeInstanceOf(
        ScannerUnavailableError,
      );
    },
  );

  it('S07 AS-25: the socket is destroyed on every exit path', async () => {
    await scan(Readable.from([Buffer.from('abc')]));
    clamd.mode = 'garbage';
    await scan(Readable.from([Buffer.from('abc')])).catch(() => undefined);
    clamd.mode = 'stall';
    await scan(Readable.from([Buffer.from('abc')]), {
      timeoutMs: 5_000,
      inactivityMs: 100,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clamd.openSockets).toBe(0);
  });

  it('S07 AS-25: it honours backpressure: a scanner that stops reading stops the source', async () => {
    clamd.mode = 'stall-mid';
    clamd.stallAfterBytes = 128 * 1024;
    const { source, pulled } = bigSource(1024 * 1024 * 1024);
    const run = scan(source, { timeoutMs: 10_000, inactivityMs: 600 }).catch(
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // the kernel buffers a few MiB; a reader that ignored backpressure would have pulled the whole GiB
    expect(pulled()).toBeLessThan(64 * 1024 * 1024);
    expect(await run).toBeInstanceOf(ScannerUnavailableError);
    expect(source.destroyed).toBe(true);
  });

  it('S07 AS-24: a socket that goes quiet is abandoned at the inactivity limit, long before the total deadline', async () => {
    clamd.mode = 'stall';
    const started = Date.now();
    await expect(
      scan(Readable.from([Buffer.from('abc')]), {
        timeoutMs: 30_000,
        inactivityMs: 300,
      }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clamd.openSockets).toBe(0);
  });

  it('S07 AS-24: a source that stops producing is abandoned at the inactivity limit', async () => {
    const source = new PassThrough();
    source.write(Buffer.from('some bytes'));
    await expect(
      scan(source, { timeoutMs: 30_000, inactivityMs: 300 }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(source.destroyed).toBe(true);
  });

  it('S07 AS-24: a scan that keeps making progress is never cut off by the inactivity limit', async () => {
    // eight pieces, 60 ms apart: 480 ms in all, more than twice the 200 ms limit, but never quiet for 200 ms
    const result = await scan(trickle(8, 60), {
      timeoutMs: 30_000,
      inactivityMs: 200,
    });
    expect(result).toEqual({ clean: true });
  });

  it('S07 AS-24: the total deadline still ends a scan that keeps trickling', async () => {
    const started = Date.now();
    await expect(
      scan(trickle(200, 40), { timeoutMs: 400, inactivityMs: 5_000 }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('S07 AS-23: a refused connection is unavailable, not a verdict', async () => {
    const down = new FakeClamd();
    const p = await down.start();
    await down.refuse();
    await expect(
      new ClamdMalwareScanner('127.0.0.1', p).scan(
        Readable.from([Buffer.from('a')]),
        {
          timeoutMs: 2_000,
        },
      ),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('S07 AS-25: scanStream keeps its positional form (the deadline is the fourth argument)', async () => {
    await expect(
      scanStream('127.0.0.1', port, Readable.from([Buffer.from('abc')]), 5_000),
    ).resolves.toEqual({ clean: true });
  });
});

describe('S07 scanner mode (AS-32)', () => {
  it('S07 AS-32: the clamd and fake scanners are active, the disabled one says so', () => {
    expect(new ClamdMalwareScanner('h', 1).kind).toBe('active');
    expect(new FakeMalwareScanner().kind).toBe('active');
    expect(new DisabledMalwareScanner().kind).toBe('disabled');
  });
});
