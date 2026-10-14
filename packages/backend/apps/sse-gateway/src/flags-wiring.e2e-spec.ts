import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { SseGatewayModule } from './sse-gateway.module';

/**
 * The real gateway application (S38 L-004, L-015, S51 follow-up): `SseGatewayModule` starts with the flags route defined
 * once in its topic registry, open to the SERVICE role only.
 */
describe('Flags wiring in the real SSE gateway application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(SseGatewayModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S38 AS-57: the started gateway knows the flags topic and lets only a service follow it', async () => {
    const registry = app.get(TopicRegistry);
    expect(registry.isKnown('flags')).toBe(true);
    expect(
      await registry.canSubscribe({ userId: 'u', roles: ['SERVICE'] }, 'flags'),
    ).toBe(true);
    expect(
      await registry.canSubscribe({ userId: 'u', roles: ['ADMIN'] }, 'flags'),
    ).toBe(false);
  });
});
