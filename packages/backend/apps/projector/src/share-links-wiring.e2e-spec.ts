import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { ShareLinksProjectorModule } from '@app/domains/marketing';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The click consumer in an application composed the way `ProjectorModule` composes it (S37 L-015, L-004): the same
 * infrastructure modules and `ProjectionsModule.forProjectors(ShareLinksProjectorModule.projectors,
 * [ShareLinksProjectorModule])`. `ProjectorModule` itself does not start in this environment for a reason outside this
 * capability (see the pickup wiring spec), so the second test pins that its declaration holds what this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(ShareLinksProjectorModule.projectors, [
      ShareLinksProjectorModule,
    ]),
  ],
})
class ShareLinksProjectorApp {}

describe('Share links wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ShareLinksProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S37 AS-43: the click consumer registers its group', async () => {
    expect(await app.get(ProjectionRegistry).get('link-clicks')).not.toBeNull();
  });

  it('S37 AS-43: ProjectorModule imports the share-links projector module and lists its consumer', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(ShareLinksProjectorModule);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of ShareLinksProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
