import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (L-004, L-015, L-018): `ProjectorModule` starts with `StatementsProjectorModule` in it
 * and declares the three fact consumers of the statements. The domain specs deliver messages through an in-memory
 * harness and cannot see a consumer that the application never loads.
 */
describe('Statements wiring in the real projector application', () => {
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

  it('S16 AS-51: the projector application starts and answers its liveness probe', async () => {
    const res = await supertest(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('S16 AS-51: the running projector declares the order, payout and ledger consumers of the statements', async () => {
    const registry = app.get(ProjectionRegistry, { strict: false });
    for (const [name, topic] of [
      ['statements-sales', 'orders.events'],
      ['statements-payouts', 'payouts.events'],
      ['statements-ledger', 'ledger.events'],
    ] as const) {
      let declared: Awaited<ReturnType<ProjectionRegistry['get']>> = null;
      await waitFor(
        async () => (declared = await registry.get(name)) !== null,
        { description: `${name} declared by the running projector` },
      );
      expect(declared).toMatchObject({ name, topics: [topic] });
    }
  });
});
