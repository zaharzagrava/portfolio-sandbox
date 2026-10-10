import { Module } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { streamEventEnvelopeSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { AssetTopicsModule } from '@app/domains/asset-library';
import { IdentityTopicsModule } from '@app/domains/identity';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import {
  RealtimeModule,
  RealtimePublisher,
  RealtimeStreamModule,
  SubscriptionHub,
} from '@app/infrastructure/realtime';
import { waitFor } from '@app/test/utils/async-helpers';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { MemberRevocationConsumer } from './infra/member-revocation.consumer';
import { ShopTopicsModule } from './realtime-topics.module';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

@Module({
  imports: [RealtimeModule],
  providers: [MemberRevocationConsumer],
  exports: [MemberRevocationConsumer],
})
class MemberRevocationProbeModule {}

/**
 * Follow-up left for S51 by S03: an open `shop:<id>:*` stream of a removed member ends when `tenancy.member_removed`
 * arrives. Real shop API, real membership rule, real stream endpoint; the consumer is fed the event the API wrote.
 */
describe('S51 follow-up from S03: member removal closes open shop streams', () => {
  let t: TenancyTestApp;
  let consumer: MemberRevocationConsumer;
  let baseUrl: string;
  const open: OpenSse[] = [];

  const stream = async (bearer: string, ...topics: string[]) => {
    const handle = await openSse(
      `${baseUrl}/streams?topics=${topics.join(',')}`,
      {
        headers: { authorization: bearer },
      },
    );
    open.push(handle);
    return handle;
  };
  const removalEvents = async (shopId: string) =>
    (await outboxRowsFor(t.app, shopId))
      .filter((e) => e.type === 'tenancy.member_removed')
      .map((e) => e.payload as unknown as EventEnvelope);
  const revoked = (handle: OpenSse) =>
    handle.frames
      .filter((f) => f.event === 'revoked')
      .map((f) => streamEventEnvelopeSchema.parse(JSON.parse(f.data!)).topic)
      .sort();

  beforeAll(async () => {
    t = await createTenancyApp({
      extraImports: [
        RealtimeStreamModule,
        IdentityTopicsModule,
        ShopTopicsModule,
        AssetTopicsModule,
        MemberRevocationProbeModule,
      ],
    });
    consumer = t.app.get(MemberRevocationConsumer);
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/api`;
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());
  afterEach(async () => {
    while (open.length) open.pop()!.close();
    await waitFor(async () => t.app.get(SubscriptionHub).channelCount() === 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
    });
  });

  it('S03 follow-up: removing a member ends their shop streams within 2 s; other members and other shops are unaffected', async () => {
    const owner = await t.newUser();
    const leaver = await t.newUser();
    const stays = await t.newUser();
    const shop = await createShop(t.app, owner);
    const otherShop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, leaver.id, 'STAFF');
    await addMember(t.app, shop.id, stays.id, 'STAFF');
    await addMember(t.app, otherShop.id, leaver.id, 'STAFF');

    const live = `shop:${shop.id}:live`;
    const assets = `shop:${shop.id}:assets`;
    const leaverStream = await stream(leaver.bearer, live, assets);
    const otherShopStream = await stream(
      leaver.bearer,
      `shop:${otherShop.id}:live`,
    );
    const stayingStream = await stream(stays.bearer, live);
    expect([
      leaverStream.status,
      otherShopStream.status,
      stayingStream.status,
    ]).toEqual([200, 200, 200]);

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${leaver.id}`)
      .expect(204);
    const [event] = await removalEvents(shop.id);
    const started = Date.now();
    await consumer.project([event]);

    await leaverStream.waitForEnd(2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(revoked(leaverStream)).toEqual([assets, live].sort());
    expect(leaverStream.frames[leaverStream.frames.length - 1].event).toBe(
      'revoked',
    );

    // no later event reaches the removed member; the remaining member and the other shop keep working
    const publisher = t.app.get(RealtimePublisher);
    await publisher.publish(live as never, 'sales', { total: 1 });
    await publisher.publish(`shop:${otherShop.id}:live` as never, 'sales', {
      total: 2,
    });
    await stayingStream.waitFor((f) => f.some((x) => x.event === 'sales'));
    await otherShopStream.waitFor((f) => f.some((x) => x.event === 'sales'));
    expect(leaverStream.events.filter((e) => e.event === 'sales')).toHaveLength(
      0,
    );
    expect(stayingStream.ended).toBe(false);
    expect(otherShopStream.ended).toBe(false);
    expect(revoked(stayingStream)).toEqual([]);
    expect(revoked(otherShopStream)).toEqual([]);
  });

  it('S03 follow-up: the membership rule still decides a reconnect', async () => {
    const owner = await t.newUser();
    const leaver = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, leaver.id, 'STAFF');
    const live = `shop:${shop.id}:live`;
    const first = await stream(leaver.bearer, live);
    expect(first.status).toBe(200);

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${leaver.id}`)
      .expect(204);
    await consumer.project([(await removalEvents(shop.id))[0]]);
    await first.waitForEnd(2_000);

    const denied = await openSse(`${baseUrl}/streams?topics=${live}`, {
      headers: { authorization: leaver.bearer },
    });
    expect(denied.status).toBe(403);

    // re-added later: admitted again — the revocation was not a ban
    await addMember(t.app, shop.id, leaver.id, 'STAFF');
    const again = await stream(leaver.bearer, live);
    expect(again.status).toBe(200);
  });

  it('S03 follow-up: consuming the same member_removed event twice is a no-op', async () => {
    const owner = await t.newUser();
    const leaver = await t.newUser();
    const stays = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, leaver.id, 'STAFF');
    await addMember(t.app, shop.id, stays.id, 'STAFF');
    const live = `shop:${shop.id}:live`;
    const leaverStream = await stream(leaver.bearer, live);
    const stayingStream = await stream(stays.bearer, live);

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${leaver.id}`)
      .expect(204);
    const [event] = await removalEvents(shop.id);
    await consumer.project([event]);
    await leaverStream.waitForEnd(2_000);
    await consumer.project([event]); // duplicate delivery
    await t.app.get(RealtimePublisher).publish(live as never, 'sales', {});
    await stayingStream.waitFor((f) => f.some((x) => x.event === 'sales'));
    expect(revoked(stayingStream)).toEqual([]);
    expect(stayingStream.ended).toBe(false);
  });

  it('S03 follow-up: an event that does not match the contract is a permanent failure', async () => {
    const bad = {
      type: 'tenancy.member_removed',
      version: 1,
      payload: { shopId: 'not-a-uuid' },
    } as unknown as EventEnvelope;
    await expect(consumer.project([bad])).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});
