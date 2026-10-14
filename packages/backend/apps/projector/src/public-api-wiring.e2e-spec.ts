import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PublicApiProjectorModule } from '@app/domains/developer-platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S42 L-015, L-004, L-018): `ProjectorModule` starts with the three public API consumers
 * in it and registers their groups. A consumer that is declared but cannot be built (a provider nobody can resolve)
 * fails here, where a spec that calls `project` on a class it assembled cannot see it.
 */
describe('Public API wiring in the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S42 AS-62: the request log, usage metering and shop lifecycle consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('public-api-request-log')).not.toBeNull();
    expect(await registry.get('public-api-usage-metering')).not.toBeNull();
    expect(await registry.get('public-api-shop-lifecycle')).not.toBeNull();
  });

  it('S42 AS-12: ProjectorModule imports the public API projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(PublicApiProjectorModule);
    expect(PublicApiProjectorModule.projectors).toHaveLength(3);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of PublicApiProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
