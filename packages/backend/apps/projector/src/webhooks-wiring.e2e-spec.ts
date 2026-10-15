import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WebhooksProjectorModule } from '@app/domains/developer-platform';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S43 L-015, L-004, L-018): `ProjectorModule` starts with the four webhook consumers in
 * it and registers their groups. A consumer that is declared but cannot be built (a provider nobody can resolve, such as
 * the routing service or the receipts) fails here, where a spec that calls `project` on a class it assembled cannot see it.
 */
describe('Webhooks wiring in the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S43 AS-30: the order, product, payout and shop-deleted consumers register their groups', async () => {
    const registry = app.get(ProjectionRegistry);
    for (const group of [
      'webhook-router-orders',
      'webhook-router-products',
      'webhook-router-payouts',
      'webhook-shop-deleted',
    ])
      expect(await registry.get(group)).not.toBeNull();
  });

  it('S43 AS-30: ProjectorModule imports the webhook projector module and lists its consumers', () => {
    const imports = Reflect.getMetadata(
      'imports',
      ProjectorModule,
    ) as unknown[];
    const flat = imports.flatMap((i) =>
      i && typeof i === 'object' && 'imports' in i
        ? [i, ...((i as { imports: unknown[] }).imports ?? [])]
        : [i],
    );
    expect(flat).toContain(WebhooksProjectorModule);
    expect(WebhooksProjectorModule.projectors).toHaveLength(4);
    const providers = imports
      .filter(
        (i): i is { providers: unknown[] } =>
          !!i && typeof i === 'object' && 'providers' in i,
      )
      .flatMap((i) => i.providers);
    for (const consumer of WebhooksProjectorModule.projectors)
      expect(providers).toContain(consumer);
  });
});
