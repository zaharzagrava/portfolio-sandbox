import {
  revokedDataSchema,
  streamEventEnvelopeSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
  type RealtimeTestUser,
} from '@app/test/utils/realtime-app';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';

/** S51 US8 (AS-54 to AS-58): removing access ends streams, fleet-wide, within 2 s. Two gateway instances, one store. */
describe('S51 revocation (REV)', () => {
  let a: RealtimeTestApp;
  let b: RealtimeTestApp;
  let alice: RealtimeTestUser;
  let bob: RealtimeTestUser;
  const open: OpenSse[] = [];
  const track = async (url: string, headers: Record<string, string> = {}) => {
    const stream = await openSse(url, { headers });
    open.push(stream);
    return stream;
  };
  const revocations = () =>
    MetricsRegistry.value('realtime_revocations_total') ?? 0;
  const revokedTopics = (stream: OpenSse) =>
    stream.frames
      .filter((f) => f.event === 'revoked')
      .map((f) => {
        const envelope = streamEventEnvelopeSchema.parse(JSON.parse(f.data!));
        expect(revokedDataSchema.parse(envelope.data)).toEqual({});
        return envelope.topic;
      });

  beforeAll(async () => {
    a = await createRealtimeApp();
    b = await createRealtimeApp({ keepStore: true });
    alice = await a.newUser();
    bob = await a.newUser();
  });
  afterAll(async () => {
    await b.close();
    await a.close();
  });
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(async () => a.hub.channelCount() === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S51 AS-54: a revoke on another instance sends revoked per matching topic; the other topics continue', async () => {
    const shop = freshId();
    a.fixtures.member(shop, alice.id);
    a.fixtures.assetMembers.add(`${shop}:${alice.id}`);
    const auction = `auction:${freshId()}` as const;
    const viewer = await track(
      a.url(`shop:${shop}:live`, `shop:${shop}:assets`, auction),
      { authorization: alice.bearer },
    );

    const started = Date.now();
    await b.subscriptions.revoke({
      userId: alice.id,
      prefix: 'shop',
      id: shop,
    });
    await viewer.waitFor(
      (f) => f.filter((x) => x.event === 'revoked').length === 2,
      2_000,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(revokedTopics(viewer).sort()).toEqual([
      `shop:${shop}:assets`,
      `shop:${shop}:live`,
    ]);

    // nothing more arrives for the revoked topics; the remaining topic still delivers
    await a.publisher.publish(`gated:${shop}`, 'noise', {});
    await b.publisher.publish(auction, 'price', { n: 1 });
    await viewer.waitFor((f) => f.some((x) => x.event === 'price'));
    expect(viewer.ended).toBe(false);
    expect(viewer.events.filter((e) => e.event === 'price')).toHaveLength(1);
  });

  it('S51 AS-54: only the suffix named in the notice is revoked', async () => {
    const shop = freshId();
    a.fixtures.member(shop, alice.id);
    a.fixtures.assetMembers.add(`${shop}:${alice.id}`);
    const viewer = await track(
      a.url(`shop:${shop}:live`, `shop:${shop}:assets`),
      {
        authorization: alice.bearer,
      },
    );
    await b.subscriptions.revoke({
      userId: alice.id,
      prefix: 'shop',
      id: shop,
      suffix: 'assets',
    });
    await viewer.waitFor((f) => f.some((x) => x.event === 'revoked'), 2_000);
    expect(revokedTopics(viewer)).toEqual([`shop:${shop}:assets`]);
    expect(viewer.ended).toBe(false);
  });

  it('S51 AS-55: revoking the last topic ends the connection after the revoked frame', async () => {
    const shop = freshId();
    a.fixtures.member(shop, alice.id);
    const viewer = await track(a.url(`shop:${shop}:live`), {
      authorization: alice.bearer,
    });
    await b.subscriptions.revoke({
      userId: alice.id,
      prefix: 'shop',
      id: shop,
    });
    await viewer.waitForEnd(2_000);
    expect(revokedTopics(viewer)).toEqual([`shop:${shop}:live`]);
    expect(viewer.frames[viewer.frames.length - 1].event).toBe('revoked');
    await waitFor(async () => a.hub.listenerCount() === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S51 AS-56: a revoke that arrives while the rule is still running applies once the rule returns', async () => {
    const id = freshId();
    a.fixtures.setMode(id, 'hold');
    const before = revocations();
    const opening = openSse(a.url(`gated:${id}`));
    await a.fixtures.heldRule(id);

    await b.subscriptions.revoke({ prefix: 'gated', id });
    await waitFor(async () => revocations() > before, {
      timeoutMs: 2_000,
      intervalMs: 10,
    });
    a.fixtures.release(id);

    const viewer = await opening;
    open.push(viewer);
    expect(viewer.status).toBe(200);
    await viewer.waitForEnd(2_000);
    expect(revokedTopics(viewer)).toEqual([`gated:${id}`]);
    a.fixtures.setMode(id, 'allow');
  });

  it('S51 AS-57: a revoke without a user ends every viewer of the topic', async () => {
    const shop = freshId();
    a.fixtures.member(shop, alice.id);
    a.fixtures.member(shop, bob.id);
    b.fixtures.member(shop, bob.id); // each instance has its own fixture rules
    const viewers = [
      await track(a.url(`shop:${shop}:live`), { authorization: alice.bearer }),
      await track(a.url(`shop:${shop}:live`), { authorization: bob.bearer }),
      await track(b.url(`shop:${shop}:live`), { authorization: bob.bearer }),
    ];
    await a.subscriptions.revoke({ prefix: 'shop', id: shop });
    await Promise.all(viewers.map((v) => v.waitForEnd(2_000)));
    for (const viewer of viewers)
      expect(revokedTopics(viewer)).toEqual([`shop:${shop}:live`]);
  });

  it('S51 AS-58: revoking is not a ban — the rule still decides a reconnect', async () => {
    const shop = freshId();
    a.fixtures.member(shop, alice.id);
    const first = await track(a.url(`shop:${shop}:live`), {
      authorization: alice.bearer,
    });
    await a.subscriptions.revoke({
      userId: alice.id,
      prefix: 'shop',
      id: shop,
    });
    await first.waitForEnd(2_000);

    const again = await track(a.url(`shop:${shop}:live`), {
      authorization: alice.bearer,
    });
    expect(again.status).toBe(200); // still a member
    await a.publisher.publish(`gated:${shop}`, 'noise', {});
    a.fixtures.removeMember(shop, alice.id);
    const denied = await openSse(a.url(`shop:${shop}:live`), {
      headers: { authorization: alice.bearer },
    });
    expect(denied.status).toBe(403); // no longer a member: the rule says no
  });
});
