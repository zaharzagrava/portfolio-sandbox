import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { ReadinessService } from '@app/infrastructure/health';

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

  it('GET /health/live is always 200', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });

  it('GET /health/ready is 200 with Postgres up and 503 once shutdown starts', async () => {
    const ready = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(ready.body.checks.postgres).toBe('up');

    app.get(ReadinessService).markShuttingDown();

    const draining = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(draining.body.shuttingDown).toBe(true);
  });
});
