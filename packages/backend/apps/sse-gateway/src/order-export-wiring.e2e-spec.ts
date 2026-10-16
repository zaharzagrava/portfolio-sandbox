import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { SseGatewayModule } from './sse-gateway.module';

/**
 * The real gateway application (S12 L-004, L-015, L-018): `SseGatewayModule` starts with the `order-export` topic defined
 * once in its registry, refuses a viewer who is no member of the export's shop, and knows no `job:` topic.
 */
describe('Order export wiring in the real SSE gateway application', () => {
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

  it('S12 T082: the started gateway knows order-export:<id>, refuses a stranger and an anonymous viewer, and has no job: topic', async () => {
    const registry = app.get(TopicRegistry);
    const topic = 'order-export:0192f3a0-0000-7000-8000-000000000001';
    expect(registry.isKnown(topic)).toBe(true);
    expect(registry.isKnown('job:0192f3a0-0000-7000-8000-000000000001')).toBe(
      false,
    );
    expect(
      await registry.canSubscribe(
        { userId: '0192f3a0-0000-7000-8000-000000000009', roles: [] } as never,
        topic,
      ),
    ).toBe(false);
    expect(await registry.canSubscribe({ roles: [] } as never, topic)).toBe(
      false,
    );
  });
});
