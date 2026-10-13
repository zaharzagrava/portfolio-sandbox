import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { MediaProjectorModule } from '@app/domains/media';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The two photo consumers in an application composed the way `ProjectorModule` composes it (S29 L-015, L-004): the same
 * infrastructure modules and `ProjectionsModule.forProjectors(MediaProjectorModule.projectors, [MediaProjectorModule])`.
 * `ProjectorModule` itself does not start in this environment for a reason outside this capability (see the pickup and
 * share-links wiring specs), so the second test pins that its declaration holds what this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(MediaProjectorModule.projectors, [
      MediaProjectorModule,
    ]),
  ],
})
class MediaProjectorApp {}

describe('Media wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(MediaProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S29 AS-39/AS-40: both consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('media-product-deleted')).not.toBeNull();
    expect(await registry.get('media-shop-deleted')).not.toBeNull();
  });

  it('S29 AS-39/AS-40: ProjectorModule imports the media projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(MediaProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of MediaProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
