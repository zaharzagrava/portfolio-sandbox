import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProjectionRegistry } from '@app/infrastructure/projections/projection-registry';
import { ProjectorModule } from './projector.module';

/**
 * The real projector application (S12 G-54, L-018): `ProjectorModule` starts without the tenancy membership model that
 * it used to register for nobody.
 */
describe('Order export: the real projector application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ProjectorModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  }, 180_000);
  afterAll(() => app?.close());

  it('S12 G-54: the projector starts, and its composition names no tenancy membership model (no consumer injects it)', () => {
    const source = readFileSync(join(__dirname, 'projector.module.ts'), 'utf8');
    expect(source).not.toMatch(/ShopMembership/);
    // The only class that injects the model is a controller of launch-events, which the projector does not host.
    expect(app.get(ProjectionRegistry, { strict: false })).toBeDefined();
  });
});
