import { v7 as uuidv7 } from 'uuid';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createWebhookKit,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createFlow, type Flow } from './testing/webhook-flow';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

describe('Webhooks: address guard at delivery', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;
  let flow: Flow;
  let w: WebhookWorld;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      extraImports: [WebhooksProjectorModule, WebhooksWorkerModule],
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
    flow = createFlow(t, queue);
  }, 120_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    queue.sent.length = 0;
    w = await t.seedWorld();
  });

  /** An endpoint whose host resolved to a public address when it was saved (the kit's receiver). */
  const saved = async () => {
    const receiver = await t.startReceiver();
    const e = await flow.endpoint(w, receiver.url());
    return { receiver, e, host: receiver.host };
  };
  const failedAttempt = async (endpointId: string) => {
    const [a] = await flow.attempts(endpointId);
    return a;
  };

  it('S43 AS-51: when the name now resolves to a private address no connection is made, the attempt is logged blocked_address and retried; a public answer delivers on the next attempt', async () => {
    const { receiver, e, host } = await saved();
    const m = await flow.route(w, e.id);

    t.resolver.set(host, ['10.0.0.5']);
    expect(await flow.lane.run(m, 1)).toBe('redeliver');

    expect(receiver.connections).toBe(0);
    expect(await failedAttempt(e.id)).toMatchObject({
      attempt: 1,
      ok: false,
      status: null,
      error: 'blocked_address',
    });
    expect(await flow.delivery(m)).toMatchObject({
      state: 'retry_scheduled',
      attempt: 2,
    });
    expect(await flow.failingSince(e.id)).not.toBeNull(); // counts as a failure

    t.resolver.set(host, [receiver.address]);
    t.clock.advance(30_000);
    expect(await flow.lane.run(m, 2)).toBe('delivered');
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0].attempt).toBe(2);
  });

  it('S43 AS-51: the connection goes to the address that was checked even if a second lookup would answer a private one; a certificate for another name is tls_error', async () => {
    const { receiver, e, host } = await saved();
    const m = await flow.route(w, e.id);
    const before = t.resolver.lookupsOf(host);
    t.resolver.sequence(host, [receiver.address], ['10.0.0.5']);

    expect(await flow.lane.run(m, 1)).toBe('delivered');

    expect(receiver.requests).toHaveLength(1); // P1 was used
    expect(t.resolver.lookupsOf(host) - before).toBe(1); // one lookup per attempt: no second one to be fooled by

    // a name whose certificate the receiver does not hold
    const wrongName = `other-${uuidv7().slice(-10)}.acme.test`;
    t.resolver.set(wrongName, [receiver.address]);
    const other = await flow.endpoint(w, `https://${wrongName}/in`);
    const m2 = await flow.route(w, other.id);
    expect(await flow.lane.run(m2, 1)).toBe('redeliver');
    expect(await failedAttempt(other.id)).toMatchObject({
      ok: false,
      status: null,
      error: 'tls_error',
    });
    expect(receiver.requests).toHaveLength(1);
  });

  describe('S43 AS-52: guard matrix at delivery', () => {
    it.each([
      ['loopback v4', ['127.0.0.1']],
      ['loopback v6', ['::1']],
      ['IPv4-mapped private', ['::ffff:10.0.0.1']],
      ['carrier-grade NAT', ['100.64.0.1']],
      ['unique-local v6', ['fd00::1']],
      ['multicast', ['224.0.0.1']],
      ['unspecified', ['0.0.0.0']],
      ['link-local metadata', ['169.254.169.254']],
      ['one public and one private answer', ['93.184.216.34', '10.0.0.5']],
    ])(
      'S43 AS-52: a resolver answer of %s is refused (blocked_address), logged as an attempt, retried; nothing is requested',
      async (_name, answers) => {
        const { receiver, e, host } = await saved();
        const m = await flow.route(w, e.id);
        t.resolver.set(host, answers);

        expect(await flow.lane.run(m, 1)).toBe('redeliver');

        expect(receiver.connections).toBe(0);
        const attempt = await failedAttempt(e.id);
        expect(attempt).toMatchObject({
          ok: false,
          status: null,
          error: 'blocked_address',
        });
        expect(attempt.responseSnippet).toBeUndefined();
        expect(await flow.delivery(m)).toMatchObject({
          state: 'retry_scheduled',
          attempt: 2,
        });
      },
    );

    it('S43 AS-52: a redirect to the metadata address is not followed: the 3xx is the failed attempt, nothing is requested from the target and no body is logged', async () => {
      const { receiver, e } = await saved();
      receiver.respondWith({
        redirect: 'http://169.254.169.254/latest/meta-data',
        status: 301,
      });
      const m = await flow.route(w, e.id);

      expect(await flow.lane.run(m, 1)).toBe('redeliver');

      expect(receiver.requests).toHaveLength(1);
      const attempt = await failedAttempt(e.id);
      expect(attempt).toMatchObject({ ok: false, status: 301 });
      expect(attempt.error).toBeUndefined();
      expect(attempt.responseSnippet).toBeUndefined();
      expect(t.resolver.lookups).not.toContain('169.254.169.254');
      expect(await flow.delivery(m)).toMatchObject({
        state: 'retry_scheduled',
        attempt: 2,
      });
    });
  });
});
