import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { OnboardingProjectorModule } from '@app/domains/seller-onboarding';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ProjectorModule } from './projector.module';

/**
 * The `tenancy.shop_deleted` consumer of seller onboarding in an application composed the way `ProjectorModule`
 * composes it (S04 L-015, L-004): the same infrastructure modules and
 * `ProjectionsModule.forProjectors(OnboardingProjectorModule.projectors, [OnboardingProjectorModule])`.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    KafkaProducerModule,
    ProjectionsModule.forProjectors(OnboardingProjectorModule.projectors, [
      OnboardingProjectorModule,
    ]),
  ],
})
class OnboardingProjectorApp {}

describe('Seller onboarding wiring in the projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(OnboardingProjectorApp, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S04 AS-60: the shop-deleted consumer registers its group', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('seller-onboarding-shop-deleted')).not.toBeNull();
  });

  it('S04 AS-60: ProjectorModule imports the onboarding projector module and lists its consumer', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(OnboardingProjectorModule);
    const providers = imports
      .flatMap((i) =>
        i && typeof i === 'object' && 'providers' in i
          ? ((i as { providers: unknown[] }).providers ?? [])
          : [],
      )
      .flat();
    for (const projector of OnboardingProjectorModule.projectors)
      expect(providers).toContain(projector);
  });
});
