import { INestApplication } from '@nestjs/common';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { AlreadyInProgressError, Idempotency } from './idempotency';

/** SD-03 idempotency records against real DynamoDB Local (conditional writes are the whole point). */
describe('Lambda idempotency (e2e, DynamoDB Local)', () => {
  let app: INestApplication;
  let idem: Idempotency;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([], { stores: ['dynamo'] });
    app = moduleRef.createNestApplication();
    await app.init();
    const dynamo = app.get(DynamoService);
    idem = new Idempotency(dynamo.doc, dynamo.table('Idempotency'), 'spec-fn');
  });

  afterAll(async () => {
    await app.close();
  });

  it('a duplicate delivery after completion replays the stored result without running', async () => {
    const key = v4();
    let runs = 0;
    const work = async () => ++runs;
    expect(await idem.run(key, 10_000, work)).toEqual({ result: 1, replayed: false });
    expect(await idem.run(key, 10_000, work)).toEqual({ result: 1, replayed: true });
    expect(runs).toBe(1);
  });

  it('two concurrent deliveries: exactly one runs, the other is told to retry later', async () => {
    const key = v4();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const first = idem.run(key, 10_000, async () => (await slow, 'done'));
    await new Promise((r) => setTimeout(r, 100));
    await expect(idem.run(key, 10_000, async () => 'second')).rejects.toBeInstanceOf(AlreadyInProgressError);
    release();
    expect((await first).result).toBe('done');
  });

  it('a failure releases the claim (retry runs again); a crashed claim expires', async () => {
    const key = v4();
    await expect(idem.run(key, 10_000, async () => Promise.reject(new Error('transient')))).rejects.toThrow('transient');
    expect(await idem.run(key, 10_000, async () => 'second try')).toEqual({ result: 'second try', replayed: false });

    const crashed = v4();
    void idem.run(crashed, 50, () => new Promise(() => undefined)); // never completes, claim expires after 50 ms
    await new Promise((r) => setTimeout(r, 300));
    expect((await idem.run(crashed, 10_000, async () => 'recovered')).result).toBe('recovered');
  });
});
