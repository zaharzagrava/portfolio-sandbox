import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S17 L-004, L-015, L-018): `ProjectorModule` starts with `BillingConsumerModule` in it
 * and declares the consumer of the shop lifecycle events. The domain specs deliver envelopes through an in-memory
 * harness and cannot see a consumer that the application never loads.
 */
describe('Billing wiring in the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S17 AS-77: the projector application starts and declares the billing tenancy-lifecycle consumer', async () => {
    expect(
      (await supertest(app.getHttpServer()).get('/health/live')).status,
    ).toBe(200);
    const registry = app.get(ProjectionRegistry, { strict: false });
    let declared: Awaited<ReturnType<ProjectionRegistry['get']>> = null;
    await waitFor(
      async () =>
        (declared = await registry.get('billing-tenancy-lifecycle')) !== null,
      {
        description:
          'billing-tenancy-lifecycle declared by the running projector',
      },
    );
    expect(declared).toMatchObject({
      name: 'billing-tenancy-lifecycle',
      topics: ['tenancy.events'],
    });
  });

  it('S18 T052: the projector application declares the three usage and entitlement consumers on their topics', async () => {
    const registry = app.get(ProjectionRegistry, { strict: false });
    for (const [name, topic] of [
      ['billing-usage-recorded', 'usage.events'],
      ['billing-llm-usage', 'llm.events'],
      ['billing-entitlement-invalidation', 'billing.events'],
    ] as const) {
      let declared: Awaited<ReturnType<ProjectionRegistry['get']>> = null;
      await waitFor(
        async () => (declared = await registry.get(name)) !== null,
        {
          description: `${name} declared by the running projector`,
        },
      );
      expect(declared).toMatchObject({ name, topics: [topic] });
    }
  });
});
