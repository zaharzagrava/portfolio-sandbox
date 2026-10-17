import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { CompetitorProjectorModule } from '@app/domains/seller-insights';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The competitor consumers in an application composed the way `ProjectorModule` composes it (S41 L-004, L-015,
 * L-018): the same infrastructure modules and
 * `ProjectionsModule.forProjectors(CompetitorProjectorModule.projectors, [CompetitorProjectorModule])`. The module
 * brings its own stores, so the standalone projector needs nothing the monolith supplies.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(CompetitorProjectorModule.projectors, [
      CompetitorProjectorModule,
    ]),
  ],
})
class CompetitorProjectorApp {}

describe('Competitor monitor wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(CompetitorProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S41 AS-51: every consumer registers its own group', async () => {
    const registry = app.get(ProjectionRegistry);
    for (const group of [
      'seller-insights-competitor-shops',
      'seller-insights-competitor-products',
    ])
      expect([group, await registry.get(group)]).not.toEqual([group, null]);
  });

  it('S41 AS-51: ProjectorModule imports the competitor projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(CompetitorProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of CompetitorProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
