import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { clientFlagsSchema } from '@marketplace-sandbox/contracts';
import supertest from 'supertest';
import { FlagsClient } from '@app/domains/experimentation';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S38 L-004, L-015): `CoreModule` starts with the flags SDK, admin
 * routes and client endpoint in it, the SDK is ready (the stores of the test stack answer), and a missing import or a
 * provider nobody can resolve fails here.
 */
describe('Flags wiring in the real core application', () => {
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

  it('S38 AS-57: the started core serves the public client flags, protects the admin routes and holds a ready SDK', async () => {
    const http = () => supertest(app.getHttpServer());

    const flags = await http()
      .get('/api/flags')
      .set('X-Anonymous-Id', 'visitor-wiring-1')
      .expect(200);
    clientFlagsSchema.parse(flags.body);
    expect(flags.headers['cache-control']).toBe('private, no-store');
    await http().get('/api/admin/flags').expect(401);
    await http().put('/api/admin/flags/wiring-flag').send({}).expect(401);
    expect(app.get(FlagsClient).ready).toBe(true);
  });
});
