import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WidgetProjectorModule } from '@app/domains/developer-platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S44 L-015, L-004, L-018): `ProjectorModule` starts with the three widget consumers in
 * it and registers their groups. A consumer that is declared but cannot be built (a provider nobody can resolve) fails
 * here, where a spec that calls `project` on a class it assembled cannot see it.
 */
describe('Widget wiring in the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S44 AS-45: the shop updated, status and deleted consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('widget-shop-updated')).not.toBeNull();
    expect(await registry.get('widget-shop-status')).not.toBeNull();
    expect(await registry.get('widget-shop-deleted')).not.toBeNull();
  });

  it('S44 AS-45: ProjectorModule imports the widget projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(WidgetProjectorModule);
    expect(WidgetProjectorModule.projectors).toHaveLength(3);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of WidgetProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
