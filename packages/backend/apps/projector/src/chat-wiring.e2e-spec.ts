import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ChatProjectorModule } from '@app/domains/chat';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S24 L-015, L-004, L-018): `ProjectorModule` starts with the chat consumers in it and
 * registers their groups. A consumer that is declared but cannot be built (a provider nobody can resolve) fails here,
 * where a spec that calls `project` on a class it assembled cannot see it.
 */
describe('Chat wiring in the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S24 AS-42: the offline scheduler and the shop purge consumer register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    expect(await registry.get('chat-offline-scheduler')).not.toBeNull();
    expect(await registry.get('chat-shop-purge')).not.toBeNull();
  });

  it('S24 AS-56: ProjectorModule imports the chat projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(ChatProjectorModule);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of ChatProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
