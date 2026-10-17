import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { SellerInsightsProjectorModule } from '@app/domains/seller-insights';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The seller-insights consumers in an application composed the way `ProjectorModule` composes it (S40 L-004, L-015,
 * L-018): the same infrastructure modules and
 * `ProjectionsModule.forProjectors(SellerInsightsProjectorModule.projectors, [SellerInsightsProjectorModule])`. The
 * module brings its own stores, so the standalone projector needs nothing the monolith supplies.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(SellerInsightsProjectorModule.projectors, [
      SellerInsightsProjectorModule,
    ]),
  ],
})
class SellerInsightsProjectorApp {}

describe('Seller insights wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(SellerInsightsProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S40 AS-58: every consumer registers its own group', async () => {
    const registry = app.get(ProjectionRegistry);
    for (const group of [
      'seller-insights-boards',
      'seller-insights-live',
      'seller-insights-sales',
      'seller-insights-refunds',
      'seller-insights-shops',
      'seller-insights-shop-erasure',
      'seller-insights-products',
    ])
      expect([group, await registry.get(group)]).not.toEqual([group, null]);
  });

  it('S40 AS-62: ProjectorModule imports the seller-insights projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(SellerInsightsProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of SellerInsightsProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
