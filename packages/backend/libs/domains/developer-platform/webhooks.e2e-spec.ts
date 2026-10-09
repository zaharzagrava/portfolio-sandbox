import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { ApiConfigService } from '@app/common/config';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { OrderPaid } from '@app/domains/orders';
import { WebhooksCoreModule } from './webhooks-core.module';
import { WebhookEndpointsService } from './application/webhook-endpoints.service';
import { WebhookRouterProjector } from './infra/webhook-router.projector';
import { WebhookDeliverer } from './application/webhook-deliverer.service';
import { verifyWebhook } from './domain/signature';
import type { WebhookDelivery } from './domain/webhook-events';

@Module({ imports: [WebhooksCoreModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

/** SD-30 against real Postgres + Redis + DynamoDB Local + ElasticMQ, delivering to a real local HTTP receiver. */
describe('Webhooks (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let endpoints: WebhookEndpointsService;
  let deliverer: WebhookDeliverer;
  let receiver: http.Server;
  let receiverUrl: string;
  let respondWith = 200;
  const received: { body: string; signature?: string }[] = [];

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({
          body,
          signature: req.headers['marketplace-signature'] as string,
        });
        res.writeHead(respondWith).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis', 'dynamo', 'sqs'],
    });
    app = moduleRef.createNestApplication();
    const config = app.get(ApiConfigService);
    const get = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'webhooks_allow_private_hosts'
          ? '127.0.0.1'
          : get(key as never)) as typeof config.get);
    await app.init();
    seeds = app.get(SeedsService);
    endpoints = app.get(WebhookEndpointsService);
    deliverer = app.get(WebhookDeliverer);
  });

  afterAll(async () => {
    await app.close();
    receiver.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    received.length = 0;
    respondWith = 200;
  });

  const shop = async () =>
    (
      await app
        .get<typeof Shop>(getModelToken(Shop))
        .create({ name: 'Hooked', slug: `h-${v4().slice(0, 8)}` })
    ).id;

  /** What the router would enqueue, for driving the deliverer directly. */
  const deliveryFor = async (
    shopId: string,
    endpointId: string,
  ): Promise<WebhookDelivery> => {
    const event = OrderPaid.create(v4(), 2, {
      userId: v4(),
      total: 5_000,
      currency: 'usd',
      paymentId: v4(),
      lines: [{ productId: v4(), shopId, quantity: 2, price: 2_500 }],
    });
    const enqueue = jest
      .spyOn(
        app.get(WebhookRouterProjector)['queue'] as {
          enqueueBatch: (...a: unknown[]) => Promise<void>;
        },
        'enqueueBatch',
      )
      .mockResolvedValueOnce();
    await app.get(WebhookRouterProjector).project([event]);
    const [, messages] = enqueue.mock.calls.at(-1) as [
      string,
      { body: WebhookDelivery; options: { groupId: string } }[],
    ];
    expect(messages[0].options.groupId).toBe(endpointId); // FIFO group = endpoint
    return messages[0].body;
  };

  it("order.paid → signed POST the receiver can verify; payload is the shop's slice in the endpoint's API version", async () => {
    const shopId = await shop();
    const ep = await endpoints.create(shopId, {
      url: receiverUrl,
      events: ['order.paid'],
      apiVersion: '2026-01-15',
    });
    const msg = await deliveryFor(shopId, ep.id);

    expect(await deliverer.deliver(msg)).toBe('delivered');
    expect(received).toHaveLength(1);
    expect(
      verifyWebhook(received[0].body, received[0].signature, ep.secret),
    ).toBe(true);
    const payload = JSON.parse(received[0].body);
    expect(payload).toMatchObject({
      type: 'order.paid',
      api_version: '2026-01-15',
      data: { object: { object: 'order', total: 5_000, currency: 'usd' } },
    });
    expect(payload.id).toMatch(/^evt_/);
    expect((await deliverer.attempts(ep.id))[0]).toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it('failures: first retries stay in the FIFO, then the long-backoff job lane; replay re-sends the stored body', async () => {
    const shopId = await shop();
    const ep = await endpoints.create(shopId, {
      url: receiverUrl,
      events: ['order.paid'],
    });
    const msg = await deliveryFor(shopId, ep.id);
    respondWith = 500;

    expect(await deliverer.deliver(msg, 1)).toBe('retry-fifo');
    expect(await deliverer.deliver(msg, 3)).toBe('retry-later');
    const [job] = await app
      .get<Sequelize>(getConnectionToken())
      .query<{ runAt: Date }>(
        `SELECT "runAt" FROM "Job" WHERE type = 'webhooks.retry' AND payload->>'endpointId' = :id`,
        {
          type: QueryTypes.SELECT,
          replacements: { id: ep.id },
        },
      );
    expect(new Date(job.runAt).getTime() - Date.now()).toBeGreaterThan(
      4 * 60_000,
    ); // first backoff step: 5 min

    respondWith = 200;
    expect(await deliverer.replay(shopId, ep.id, msg.eventId)).toBe(
      'delivered',
    );
    expect(received[received.length - 1].body).toBe(msg.body); // byte-identical (same event id)
    expect(await deliverer.replay(await shop(), ep.id, msg.eventId)).toBe(
      'skipped',
    ); // another shop can't replay it
  });

  it('SSRF: private / metadata / non-https targets are refused at creation', async () => {
    const shopId = await shop();
    for (const url of [
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest/meta-data',
      'http://example.com/hook',
      'https://[::1]/hook',
    ]) {
      await expect(
        endpoints.create(shopId, { url, events: ['order.paid'] }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('secret rotation: both secrets sign for 24 h, so receivers on either verify', async () => {
    const shopId = await shop();
    const ep = await endpoints.create(shopId, {
      url: receiverUrl,
      events: ['order.paid'],
    });
    const { secret: next } = await endpoints.rotateSecret(shopId, ep.id);
    await deliverer.deliver(await deliveryFor(shopId, ep.id));
    expect(
      verifyWebhook(received[0].body, received[0].signature, ep.secret),
    ).toBe(true);
    expect(verifyWebhook(received[0].body, received[0].signature, next)).toBe(
      true,
    );
  });
});
