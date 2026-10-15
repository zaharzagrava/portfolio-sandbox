import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S08 L-004, L-015, L-018): `ProjectorModule` starts with `IntegrationsProjectorModule`
 * in it (the old stock-push projector is gone). Product and tenancy event consumers join that module in later stories.
 */
describe('Integrations wiring in the real projector application', () => {
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

  it('S08 AS-40: the projector application starts and answers its liveness probe', async () => {
    const res = await supertest(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('S08 AS-74: the running projector declares the product and tenancy consumers of the capability', async () => {
    const registry = app.get(ProjectionRegistry, { strict: false });
    for (const [name, topic, idempotency] of [
      ['catalog-sync-product-events', 'products.events', 'natural'],
      ['catalog-sync-shop-offboarding', 'tenancy.events', 'inbox'],
      ['catalog-sync-shop-deleted', 'tenancy.events', 'natural'],
    ] as const) {
      let declared: Awaited<ReturnType<ProjectionRegistry['get']>> = null;
      await waitFor(
        async () => (declared = await registry.get(name)) !== null,
        {
          description: `${name} declared by the running projector`,
        },
      );
      expect(declared).toMatchObject({ name, topics: [topic], idempotency });
    }
  });
});
