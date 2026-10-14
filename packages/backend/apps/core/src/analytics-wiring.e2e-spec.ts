import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assignmentsResponseSchema } from '@marketplace-sandbox/contracts';
import supertest from 'supertest';
import { PolicyRegistry } from '@app/infrastructure/rate-limit/policy-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S39 L-004, L-015): `CoreModule` starts with the analytics module in
 * it, its four rate-limit policies are declared (a name nobody declared fails the start), the public routes answer and
 * the admin routes are closed to anonymous callers.
 */
describe('Analytics wiring in the real core application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(CoreModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S39 AS-56: the started core declares the four policies, serves ingest and assignments and protects the admin routes', async () => {
    const http = () => supertest(app.getHttpServer());
    const registry = app.get(PolicyRegistry, { strict: false });
    for (const name of [
      'analytics.ingest',
      'experiments.assignments',
      'experiments.admin.write',
      'experiments.results',
    ])
      expect(() => registry.get(name as never)).not.toThrow();

    const assignments = await http()
      .get('/api/experiments/assignments')
      .set('X-Anonymous-Id', 'visitor-wiring-1')
      .expect(200);
    assignmentsResponseSchema.parse(assignments.body);
    expect(assignments.headers['cache-control']).toBe('private, no-store');

    const refused = await http()
      .post('/api/events')
      .set('Content-Type', 'application/json')
      .send({ events: [] })
      .expect(400);
    expect(refused.body.code).toBe('validation_failed');

    await http().get('/api/admin/experiments').expect(401);
    await http()
      .put('/api/admin/experiments/wiring-experiment')
      .send({})
      .expect(401);
    await http()
      .get('/api/admin/experiments/wiring-experiment/results')
      .expect(401);
  });
});
