import { INestApplication } from '@nestjs/common';
import { v4 } from 'uuid';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { Idempotency } from './idempotency';
import {
  AlreadyInProgressError,
  IdempotencyKeyConflictError,
  StaleClaimError,
} from './idempotency-errors';
import { TransientError } from '../errors';
import {
  captureTelemetry,
  deferred,
  FakeClock,
  type Capture,
} from '../testing';

/** Idempotency records against real DynamoDB Local (conditional writes are the whole point), on a frozen clock. */
describe('Lambda idempotency (e2e, DynamoDB Local)', () => {
  let app: INestApplication;
  let doc: DynamoDBDocumentClient;
  let table: string;
  let clock: FakeClock;
  let capture: Capture;
  const faults = {
    failNext: undefined as undefined | (new (...a: any[]) => object),
  };

  /** A client whose network edge can be told to fail the next command of one kind (store fault injection). */
  const edge = {
    send: (command: any, ...rest: any[]) => {
      if (faults.failNext && command instanceof faults.failNext) {
        faults.failNext = undefined;
        return Promise.reject(
          Object.assign(new Error('throughput exceeded'), {
            name: 'ProvisionedThroughputExceededException',
          }),
        );
      }
      return (doc.send as any)(command, ...rest);
    },
  } as unknown as DynamoDBDocumentClient;

  const make = (fn = `fn-${v4()}`) =>
    new Idempotency(edge, table, fn, { now: clock.now });
  const read = async (fn: string, key: string) =>
    (
      await doc.send(
        new GetCommand({
          TableName: table,
          Key: { PK: `${fn}#${key}` },
          ConsistentRead: true,
        }),
      )
    ).Item;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([], { stores: ['dynamo'] });
    app = moduleRef.createNestApplication();
    await app.init();
    const dynamo = app.get(DynamoService);
    doc = dynamo.doc;
    table = dynamo.table('Idempotency');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    clock = new FakeClock();
    capture = captureTelemetry(clock);
    faults.failNext = undefined;
  });
  afterEach(() => capture.restore());

  it('S55 AS-13: the record is IN_PROGRESS with lease and owner token mid-flight and COMPLETED with the result after', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    const T = clock.now();
    const gate = deferred<string>();
    const running = idem.run(key, () => gate.promise, { leaseMs: 120_000 });
    const mid = await (async () => {
      for (;;) {
        const item = await read(fn, key);
        if (item) return item;
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    expect(mid).toMatchObject({
      status: 'IN_PROGRESS',
      leaseUntil: T + 120_000,
    });
    expect(typeof mid.ownerToken).toBe('string');
    gate.resolve('payload');
    expect(await running).toEqual({ result: 'payload', replayed: false });
    const done = await read(fn, key);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      ownerToken: mid.ownerToken,
      expiresAtEpoch: Math.floor(T / 1000) + 24 * 3600,
      completedAt: T,
    });
    expect(JSON.parse(done!.result)).toBe('payload');
  });

  it('S55 AS-14: a duplicate after completion replays the stored result without running and changes nothing', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    let runs = 0;
    const work = async () => ++runs;
    expect(await idem.run(key, work, { leaseMs: 10_000 })).toEqual({
      result: 1,
      replayed: false,
    });
    const before = await read(fn, key);
    expect(await idem.run(key, work, { leaseMs: 10_000 })).toEqual({
      result: 1,
      replayed: true,
    });
    expect(runs).toBe(1);
    expect(await read(fn, key)).toEqual(before);
    expect(capture.metrics('IdempotencyReplay')).toHaveLength(1);
  });

  it('S55 AS-15: two concurrent deliveries: exactly one runs, the other gets AlreadyInProgressError, one record', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    let runs = 0;
    const gate = deferred();
    const work = async () => {
      runs++;
      await gate.promise;
      return 'done';
    };
    const results = Promise.allSettled([
      idem.run(key, work, { leaseMs: 10_000 }),
      idem.run(key, work, { leaseMs: 10_000 }),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    gate.resolve();
    const [a, b] = await results;
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (o) => o.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AlreadyInProgressError);
    expect(runs).toBe(1);
    expect(await read(fn, key)).toMatchObject({ status: 'COMPLETED' });
  });

  it('S55 AS-16: a failure releases only the own claim and the retry runs again', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    await expect(
      idem.run(key, () => Promise.reject(new Error('transient')), {
        leaseMs: 10_000,
      }),
    ).rejects.toThrow('transient');
    expect(await read(fn, key)).toBeUndefined();
    expect(
      await idem.run(key, async () => 'second try', { leaseMs: 10_000 }),
    ).toEqual({
      result: 'second try',
      replayed: false,
    });
  });

  it('S55 AS-17: a stale holder cannot complete or release the record another attempt took over', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    const finishA = deferred<string>();
    const failA = deferred<string>();
    const a = idem.run(key, () => finishA.promise, { leaseMs: 50 });
    const a2Key = v4();
    const a2 = idem.run(a2Key, () => failA.promise, { leaseMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    clock.advance(100); // both leases pass
    expect(await idem.run(key, async () => 'B', { leaseMs: 10_000 })).toEqual({
      result: 'B',
      replayed: false,
    });
    // a different attempt took over the second key as well and is still running
    const finishB2 = deferred<string>();
    const b2 = idem.run(a2Key, () => finishB2.promise, { leaseMs: 10_000 });
    await new Promise((r) => setTimeout(r, 150));

    finishA.resolve('A');
    await expect(a).rejects.toBeInstanceOf(StaleClaimError);
    expect(JSON.parse((await read(fn, key))!.result)).toBe('B');

    failA.reject(new Error('A failed'));
    await expect(a2).rejects.toBeInstanceOf(StaleClaimError);
    expect(await read(fn, a2Key)).toMatchObject({ status: 'IN_PROGRESS' }); // B2's claim survived A's release
    finishB2.resolve('B2');
    expect((await b2).result).toBe('B2');
  });

  it('S55 AS-18: a completed record past its retention runs again as a first delivery', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    await idem.run(key, async () => 'old', {
      leaseMs: 10_000,
      retentionSec: 60,
    });
    clock.advance(61_000); // the record is still in the table (expiry deletion is lazy)
    expect(await read(fn, key)).toBeDefined();
    expect(await idem.run(key, async () => 'new', { leaseMs: 10_000 })).toEqual(
      {
        result: 'new',
        replayed: false,
      },
    );
    expect(JSON.parse((await read(fn, key))!.result)).toBe('new');
  });

  it.each(['COMPLETED', 'IN_PROGRESS'])(
    'S55 AS-19: a different fingerprint on a %s record is a conflict and changes nothing',
    async (state) => {
      const fn = `fn-${v4()}`;
      const idem = make(fn);
      const key = v4();
      const gate = deferred<string>();
      const first = idem.run(
        key,
        () => (state === 'COMPLETED' ? Promise.resolve('x') : gate.promise),
        {
          leaseMs: 10_000,
          fingerprint: 'F1',
        },
      );
      if (state === 'COMPLETED') await first;
      else await new Promise((r) => setTimeout(r, 150));
      const before = await read(fn, key);
      const work = jest.fn();
      await expect(
        idem.run(key, work, { leaseMs: 10_000, fingerprint: 'F2' }),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
      expect(work).not.toHaveBeenCalled();
      expect(await read(fn, key)).toEqual(before);
      gate.resolve('x');
      await first;
    },
  );

  it('S55 AS-19: with no fingerprint on either side the check is skipped', async () => {
    const idem = make();
    const key = v4();
    await idem.run(key, async () => 1, { leaseMs: 10_000 });
    expect(
      (await idem.run(key, async () => 2, { leaseMs: 10_000 })).replayed,
    ).toBe(true);
  });

  it('S55 AS-20: records are per function', async () => {
    const key = v4();
    const one = make(`fn-${v4()}`);
    const two = make(`fn-${v4()}`);
    await one.run(key, async () => 'one', { leaseMs: 10_000 });
    expect(await two.run(key, async () => 'two', { leaseMs: 10_000 })).toEqual({
      result: 'two',
      replayed: false,
    });
  });

  it('S55 AS-22: 64 KiB is stored and replayed in full; one byte more is omitted', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    // JSON.stringify of a string adds two quote characters
    const exact = 'x'.repeat(64 * 1024 - 2);
    const over = 'x'.repeat(64 * 1024 - 1);
    const k1 = v4();
    const k2 = v4();
    await idem.run(k1, async () => exact, { leaseMs: 10_000 });
    expect(await idem.run(k1, jest.fn(), { leaseMs: 10_000 })).toEqual({
      result: exact,
      replayed: true,
    });
    await idem.run(k2, async () => over, { leaseMs: 10_000 });
    expect(await read(fn, k2)).toMatchObject({
      status: 'COMPLETED',
      resultOmitted: true,
    });
    expect((await read(fn, k2))!.result).toBeUndefined();
    const work = jest.fn();
    expect(await idem.run(k2, work, { leaseMs: 10_000 })).toEqual({
      result: undefined,
      replayed: true,
      resultOmitted: true,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('S55 AS-23: a failed completion write keeps the claim; in-lease duplicate is in progress, post-lease reruns', async () => {
    const fn = `fn-${v4()}`;
    const idem = make(fn);
    const key = v4();
    let runs = 0;
    const work = async () => ++runs;
    faults.failNext = UpdateCommand;
    await expect(
      idem.run(key, work, { leaseMs: 10_000 }),
    ).rejects.toMatchObject({
      name: 'ProvisionedThroughputExceededException',
    });
    expect(await read(fn, key)).toMatchObject({ status: 'IN_PROGRESS' });
    expect(capture.metrics('IdempotencyCompletionFailed')).toHaveLength(1);
    await expect(
      idem.run(key, work, { leaseMs: 10_000 }),
    ).rejects.toBeInstanceOf(AlreadyInProgressError);
    expect(runs).toBe(1);
    clock.advance(10_001);
    expect(await idem.run(key, work, { leaseMs: 10_000 })).toEqual({
      result: 2,
      replayed: false,
    });
  });

  it('S55 AS-24: a claim write that fails means the work does not run and the error is transient', async () => {
    const idem = make();
    const work = jest.fn();
    faults.failNext = PutCommand;
    const error = await idem
      .run(v4(), work, { leaseMs: 10_000 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(work).not.toHaveBeenCalled();
  });

  it('S55 AS-25: a bad lease or key never reaches the store', async () => {
    const idem = new Idempotency(edge, table, 'fn', {
      now: clock.now,
      functionTimeoutMs: 30_000,
    });
    const spy = jest.spyOn(doc, 'send');
    await expect(idem.run(v4(), jest.fn(), { leaseMs: 1_000 })).rejects.toThrow(
      /shorter than the function timeout/,
    );
    await expect(idem.run('', jest.fn(), { leaseMs: 60_000 })).rejects.toThrow(
      /empty/,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
