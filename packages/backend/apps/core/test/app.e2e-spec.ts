import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';

/** F-01 health semantics: liveness never depends on the DB, readiness flips on shutdown. */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([]);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /livez is always 200', async () => {
    await request(app.getHttpServer()).get('/livez').expect(200);
  });

  it('GET /readyz is 200 with Postgres up and 503 once shutdown starts', async () => {
    const ready = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(ready.body.checks.postgres.ok).toBe(true);

    app.get(ReadinessService).markShuttingDown();

    const draining = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(draining.body.shuttingDown).toBe(true);
  });
});
