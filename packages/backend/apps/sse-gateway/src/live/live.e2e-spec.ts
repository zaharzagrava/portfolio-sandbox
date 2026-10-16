import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { SseGatewayModule } from '../sse-gateway.module';

/**
 * The real gateway application (S23 L-004, L-015, L-018): `SseGatewayModule` starts with the live stream topics defined.
 * The behavior scenarios (sampling, batching, snapshots) live in the domain's `live-delivery.e2e-spec.ts`.
 */
describe('Live stream wiring in the real SSE gateway application', () => {
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

  const id = '0192f3a0-0000-7000-8000-000000000001';
  const member = { userId: '0192f3a0-0000-7000-8000-000000000009', roles: [] };
  const admin = {
    userId: '0192f3a0-0000-7000-8000-00000000000a',
    roles: ['ADMIN'],
  };
  const anonymous = { roles: [] };
  const can = (who: object, topic: string) =>
    app.get(TopicRegistry).canSubscribe(who as never, topic);

  it('S23 AS-13: the started gateway knows the public stream topic', () => {
    expect(app.get(TopicRegistry).isKnown(`stream:${id}`)).toBe(true);
  });

  it('S23 AS-13: the comment feed and an unregistered prefix are unknown, like any other topic', () => {
    const registry = app.get(TopicRegistry);
    expect(registry.isKnown(`livefeed:${id}`)).toBe(false);
    expect(registry.isKnown(`nonsense:${id}`)).toBe(false);
    expect(registry.isKnown('livefeed:')).toBe(false);
  });

  it('S23 AS-13: nobody can subscribe to the comment feed, whatever their role', async () => {
    expect(await can(member, `livefeed:${id}`)).toBe(false);
    expect(await can(admin, `livefeed:${id}`)).toBe(false);
    expect(await can(anonymous, `livefeed:${id}`)).toBe(false);
  });

  it('S23 AS-13: the public control topic is open to a member, an admin and an anonymous viewer', async () => {
    expect(await can(member, `stream:${id}`)).toBe(true);
    expect(await can(admin, `stream:${id}`)).toBe(true);
    expect(await can(anonymous, `stream:${id}`)).toBe(true);
  });

  it('S23 AS-13: an unregistered prefix is refused to everyone', async () => {
    expect(await can(member, `nonsense:${id}`)).toBe(false);
    expect(await can(admin, `nonsense:${id}`)).toBe(false);
    expect(await can(anonymous, `nonsense:${id}`)).toBe(false);
  });
});
