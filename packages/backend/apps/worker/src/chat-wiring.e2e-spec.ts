import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { ChatOfflineWorkerModule } from '@app/domains/chat';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S24 L-004, L-015, L-018): `WorkerModule` starts with `ChatOfflineWorkerModule` in it, the
 * two chat job types are declared with payload contracts and scheduled once, and the offline-check consumer is part of
 * the module that starts.
 */
describe('Chat wiring in the real worker application', () => {
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

  it('S24 AS-29: the started worker declares the partition and backfill jobs with strict contracts and has scheduled them', async () => {
    expect(app.get(ChatOfflineWorkerModule, { strict: false })).toBeInstanceOf(
      ChatOfflineWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    for (const name of ['chat.partition-maintenance', 'chat.backfill-shops']) {
      const declaration = getJobTypeDeclaration(name as never);
      expect(declaration?.contract.safeParse({}).success).toBe(true);
      expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    }
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'chat.%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual([
      'chat.backfill-shops',
      'chat.partition-maintenance',
    ]);
  });

  it('S24 AS-46: the offline-check consumer is a provider of the module the worker starts', () => {
    const providers = Reflect.getMetadata(
      'providers',
      ChatOfflineWorkerModule,
    ) as Array<{ name?: string }>;
    expect(providers.map((p) => p.name)).toContain('ChatOfflineWorker');
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    expect(imports).toContain(ChatOfflineWorkerModule);
  });
});
