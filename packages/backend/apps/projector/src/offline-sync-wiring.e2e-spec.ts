import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S09 L-004, L-015, L-018): `ProjectorModule` starts with `OfflineSyncProjectorModule`
 * in it and declares the three consumers of offline sync, next to the integrations ones.
 */
describe('Offline sync wiring in the real projector application', () => {
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

  it('S09 AS-26: the projector application starts and declares the feed and lifecycle consumers', async () => {
    expect(
      (await supertest(app.getHttpServer()).get('/health/live')).status,
    ).toBe(200);
    const registry = app.get(ProjectionRegistry, { strict: false });
    for (const [name, topic] of [
      ['catalog-sync-offline-feed', 'products.events'],
      ['catalog-sync-offline-product-deleted', 'products.events'],
      ['catalog-sync-offline-shop-deleted', 'tenancy.events'],
    ] as const) {
      let declared: Awaited<ReturnType<ProjectionRegistry['get']>> = null;
      await waitFor(
        async () => (declared = await registry.get(name)) !== null,
        { description: `${name} declared by the running projector` },
      );
      expect(declared).toMatchObject({
        name,
        topics: [topic],
        idempotency: 'natural',
      });
    }
  });
});
