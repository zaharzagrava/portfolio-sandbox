import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { SseGatewayModule } from './sse-gateway.module';

/**
 * The real gateway application (S24 L-004, L-015, L-018): `SseGatewayModule` starts with the `chat` topic defined once in
 * its registry; its policy refuses a viewer who is not an active member, and a channel id that is not a UUID.
 */
describe('Chat wiring in the real SSE gateway application', () => {
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

  it('S24 AS-35: the started gateway knows the chat topic and refuses a stranger and a malformed channel id', async () => {
    const registry = app.get(TopicRegistry);
    expect(registry.isKnown('chat:0192f3a0-0000-7000-8000-000000000001')).toBe(
      true,
    );
    const stranger = {
      userId: '0192f3a0-0000-7000-8000-000000000009',
      roles: [] as string[],
    };
    expect(
      await registry.canSubscribe(
        stranger as never,
        'chat:0192f3a0-0000-7000-8000-000000000001',
      ),
    ).toBe(false);
    expect(
      await registry.canSubscribe(stranger as never, 'chat:not-a-uuid'),
    ).toBe(false);
    expect(
      await registry.canSubscribe(
        { roles: [] } as never,
        'chat:0192f3a0-0000-7000-8000-000000000001',
      ),
    ).toBe(false);
  });
});
