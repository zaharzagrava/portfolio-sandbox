import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { AnalyticsProjectorModule } from '@app/domains/experimentation';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The purchase consumer in an application composed the way `ProjectorModule` composes it (S39 L-015, L-004): the same
 * infrastructure modules and `ProjectionsModule.forProjectors(AnalyticsProjectorModule.projectors,
 * [AnalyticsProjectorModule])`. `ProjectorModule` itself does not start in this environment for a reason outside this
 * capability (see the pickup wiring spec), so the second test pins that its declaration holds what this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(AnalyticsProjectorModule.projectors, [
      AnalyticsProjectorModule,
    ]),
  ],
})
class AnalyticsProjectorApp {}

describe('Analytics wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AnalyticsProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S39 AS-15: the purchase consumer registers its group', async () => {
    expect(
      await app.get(ProjectionRegistry).get('analytics-purchases'),
    ).not.toBeNull();
  });

  it('S39 AS-15: ProjectorModule imports the analytics projector module and lists its consumer', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(AnalyticsProjectorModule);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of AnalyticsProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
