import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { AssetsProjectorModule } from '@app/domains/asset-library';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The asset library's consumers in an application composed the way `ProjectorModule` composes it (S31 L-015, L-018):
 * the same infrastructure modules and `ProjectionsModule.forProjectors(AssetsProjectorModule.projectors, [AssetsProjectorModule])`.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(AssetsProjectorModule.projectors, [
      AssetsProjectorModule,
    ]),
  ],
})
class AssetsProjectorApp {}

describe('Asset library wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AssetsProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S31 AS-62: the order and the catalog/shop consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('asset-library-orders')).not.toBeNull();
    expect(await registry.get('asset-library-catalog-shop')).not.toBeNull();
  });

  it('S31 AS-62: ProjectorModule imports the asset projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(AssetsProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of AssetsProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
