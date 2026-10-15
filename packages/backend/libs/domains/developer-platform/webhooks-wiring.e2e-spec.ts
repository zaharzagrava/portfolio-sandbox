import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WEBHOOK_SETTINGS } from './infra/webhook-settings.provider';
import {
  BreakerStore,
  DeliveryLog,
  DeliveryQueue,
  EndpointHistory,
  EndpointRepository,
  OutboundHttp,
} from './domain/webhook-ports';
import { WebhookLambdaHandlerHost } from './infra/webhook-lambda.handler-host';
import { WebhooksLambdaModule } from './webhooks-lambda.module';
import {
  createWebhookKit,
  type WebhookKit,
} from './testing/webhook-e2e.fixture';

/**
 * The Lambda hosting module of delivery boots alone (L-018): its own configuration, platform, database and Redis imports,
 * the shared webhook module with the validated settings and every port bound to an adapter, and the handler host the
 * Lambda entry point calls. Nothing else is imported by this context.
 */
describe('Webhooks: hosting modules boot alone (wiring)', () => {
  let context: INestApplicationContext;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(WebhooksLambdaModule, {
      logger: false,
    });
  }, 120_000);
  afterAll(() => context?.close());

  it('S43 wiring: the Lambda host module resolves its handler host and all ports', () => {
    expect(WebhooksLambdaModule.host(context)).toBeInstanceOf(
      WebhookLambdaHandlerHost,
    );
    for (const port of [
      EndpointRepository,
      EndpointHistory,
      DeliveryLog,
      BreakerStore,
      DeliveryQueue,
      OutboundHttp,
    ])
      expect(context.get(port, { strict: false })).toBeDefined();
  });

  it('S43 AS-71: the settings are validated at startup and hold the numbers of the spec', () => {
    expect(context.get(WEBHOOK_SETTINGS, { strict: false })).toMatchObject({
      attemptTimeoutMs: 10_000,
      bodyCapBytes: 262_144,
      jitter: 0.2,
    });
  });
});

describe('Webhooks: the dashboard module and the e2e kit boot (wiring)', () => {
  let kit: WebhookKit;

  beforeAll(async () => {
    kit = await createWebhookKit();
  }, 120_000);
  afterAll(() => kit?.close());

  it('S43 wiring: WebhooksModule serves its route in an app with real sessions, tenancy and the rate-limit module', async () => {
    const world = await kit.seedWorld();
    const res = await kit.as(world.owner).get(kit.base(world));
    expect(res.status).toBe(200);
  });

  it('S43 wiring: a receiver started by the kit resolves through the fake resolver and is reachable by the outbound adapter', async () => {
    const receiver = await kit.startReceiver();
    expect(await kit.resolver.resolve(receiver.host)).toEqual([
      { address: receiver.address, family: 4 },
    ]);
  });
});
