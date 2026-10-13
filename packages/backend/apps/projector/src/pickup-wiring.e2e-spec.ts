import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { PickupProjectorModule } from '@app/domains/fulfilment';
import { DatabaseModule } from '@app/infrastructure/database';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The pickup consumers in an application composed the way `ProjectorModule` composes them (S19 L-015, L-004): the same
 * infrastructure modules, `ProjectionsModule.forProjectors(PickupProjectorModule.projectors, [PickupProjectorModule])`,
 * the barrel import that `projector.module.ts` uses. The consumers start, register their groups and the index mapping
 * exists afterwards.
 *
 * `ProjectorModule` itself does not start in this environment for a reason outside this capability
 * (`NotificationsCoreModule` cannot resolve `MembershipQueryService`, S28), so it is not booted whole here; the second
 * test pins that the pickup part of its declaration is the one this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    ElasticsearchModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(PickupProjectorModule.projectors, [
      PickupProjectorModule,
    ]),
  ],
})
class PickupProjectorApp {}

describe('Pickup wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(PickupProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S19 AS-24: the four pickup consumers register their groups and the index mapping exists', async () => {
    const registry = app.get(ProjectionRegistry);
    for (const name of [
      'pickup-index-stock',
      'pickup-index-point',
      'pickup-index-product',
      'pickup-index-shop',
    ])
      expect(await registry.get(name)).not.toBeNull();
    expect(
      await app.get(SearchEngineClient).indexExists('pickup_availability_v2'),
    ).toBe(true);
  });

  it('S19 AS-24: ProjectorModule imports the pickup module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(PickupProjectorModule);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of PickupProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
