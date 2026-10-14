import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { KnowledgeProjectorModule } from '@app/domains/assistant';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The two deletion consumers in an application composed the way `ProjectorModule` composes it (S47 L-004, L-015): the same
 * infrastructure modules and `ProjectionsModule.forProjectors(KnowledgeProjectorModule.projectors,
 * [KnowledgeProjectorModule])`. `ProjectorModule` itself does not start in this environment for a reason outside this
 * capability (see the pickup wiring spec), so the second test pins that its declaration holds what this spec boots.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(KnowledgeProjectorModule.projectors, [
      KnowledgeProjectorModule,
    ]),
  ],
})
class KnowledgeProjectorApp {}

describe('Knowledge wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(KnowledgeProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S47 AS-50: both deletion consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('knowledge-product-deleted')).not.toBeNull();
    expect(await registry.get('knowledge-shop-deleted')).not.toBeNull();
  });

  it('S47 AS-51: ProjectorModule imports the knowledge projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(KnowledgeProjectorModule);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of KnowledgeProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
