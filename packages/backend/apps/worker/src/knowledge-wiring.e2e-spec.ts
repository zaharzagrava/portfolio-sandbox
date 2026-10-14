import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { KnowledgeWorkerModule } from '@app/domains/assistant';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S47 L-004, L-015): `WorkerModule` starts with `KnowledgeWorkerModule` in it, the ingestion
 * consumer is built, the sweep job type is declared with its strict empty payload and its schedule is registered once.
 */
describe('Knowledge wiring in the real worker application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(WorkerModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S47 AS-26: the started worker contains the knowledge worker module with its ingestion consumer, declares the sweep job and has registered its schedule once', async () => {
    expect(app.get(KnowledgeWorkerModule, { strict: false })).toBeInstanceOf(
      KnowledgeWorkerModule,
    );
    const providers = Reflect.getMetadata(
      'providers',
      KnowledgeWorkerModule,
    ) as { name: string }[];
    expect(providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(['KnowledgeIngestConsumer', 'KnowledgeSweepJobs']),
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const declaration = getJobTypeDeclaration('knowledge.sweep');
    expect(declaration?.contract.safeParse({}).success).toBe(true);
    expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'knowledge.%'`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual(['knowledge.sweep']);
  });
});
