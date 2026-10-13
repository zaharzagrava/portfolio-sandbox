import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { VideoProjectorModule } from '@app/domains/media';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The three video consumers in an application composed the way `ProjectorModule` composes it (S30 L-015, L-004): the
 * same infrastructure modules and `ProjectionsModule.forProjectors(VideoProjectorModule.projectors, [VideoProjectorModule])`.
 * `ProjectorModule` itself does not start in this environment for a reason outside this capability (see the media,
 * pickup and share-links wiring specs), so the second test pins that its declaration holds what this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(VideoProjectorModule.projectors, [
      VideoProjectorModule,
    ]),
  ],
})
class VideoProjectorApp {}

describe('Video wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(VideoProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S30 AS-53/AS-54/AS-55: the three consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('video-product-deleted')).not.toBeNull();
    expect(await registry.get('video-shop-deleted')).not.toBeNull();
    expect(await registry.get('video-shop-status')).not.toBeNull();
  });

  it('S30 AS-59: ProjectorModule imports the video projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(VideoProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of VideoProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
