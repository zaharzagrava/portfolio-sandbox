import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionApi } from '@/lib/api/session';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { installLiveStreamStub, type LiveStreamStub } from '@/lib/test/event-source-stub';
import { liveFrameFixture, SELLER_SHOP_ID, OTHER_SHOP_ID } from '@/lib/test/seller-handlers';
import { getUserStreamSnapshot, parseLiveFrame, resetUserStream, subscribeTopic, subscribeUserEvents } from './user-stream';

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const live = (shopId: string) => `shop:${shopId}:live`;

describe('W04 subscribeTopic and parseLiveFrame', () => {
  let stream: LiveStreamStub;
  const ended = vi.fn();

  beforeEach(() => {
    stream = installLiveStreamStub();
    ended.mockClear();
    rearmSessionEnd();
    setSessionEndHandler(ended);
  });
  afterEach(() => {
    resetUserStream();
    vi.restoreAllMocks();
  });

  it('W04 AS-25: a topic subscriber opens one same-origin stream with the topic in the address', () => {
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(SELLER_SHOP_ID)]);
    expect(stream.last().withCredentials).toBe(true);
    expect(stream.last().url).toMatch(/^\/api\/streams\?topics=shop:/);
  });

  it('W04 AS-25: the topic is added to the page connection of the signed-in user, never a second connection', () => {
    subscribeUserEvents({ onEvent: vi.fn() }, USER);
    stream.open();
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([`user:${USER}`, live(SELLER_SHOP_ID)]);
  });

  it('W04 AS-25: two subscribers of one topic share it, and several topics share one connection', () => {
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    expect(stream.opened()).toBe(1);
    subscribeTopic(live(OTHER_SHOP_ID), vi.fn());
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(SELLER_SHOP_ID), live(OTHER_SHOP_ID)]);
  });

  it('W04 AS-25: the release function drops the topic; the last release closes the connection', () => {
    const releaseA = subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    const releaseB = subscribeTopic(live(OTHER_SHOP_ID), vi.fn());
    releaseA();
    releaseA();
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(OTHER_SHOP_ID)]);
    releaseB();
    expect(stream.connections()).toBe(0);
    expect(getUserStreamSnapshot().health).toBe('closed');
  });

  it('W04 AS-25: swapping the shop (release, then subscribe) never leaves two live connections', () => {
    const release = subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    stream.open();
    release();
    subscribeTopic(live(OTHER_SHOP_ID), vi.fn());
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(OTHER_SHOP_ID)]);
  });

  it('W04 AS-19: a dashboard event of the topic reaches the handler as {type, data}; other topics do not', () => {
    const mine = vi.fn();
    const other = vi.fn();
    subscribeTopic(live(SELLER_SHOP_ID), mine);
    subscribeTopic(live(OTHER_SHOP_ID), other);
    stream.open();
    const frame = liveFrameFixture();
    stream.frame('dashboard', live(SELLER_SHOP_ID), frame);
    expect(mine).toHaveBeenCalledWith({ type: 'dashboard', data: frame });
    expect(other).not.toHaveBeenCalled();
  });

  it('W04 AS-21: resync reaches the handler so it can refetch', () => {
    const handler = vi.fn();
    subscribeTopic(live(SELLER_SHOP_ID), handler);
    stream.open();
    stream.resync();
    expect(handler).toHaveBeenCalledWith({ type: 'resync', data: null });
  });

  it('W04 AS-21: a reconnect after an error is a resync for the handler', () => {
    const handler = vi.fn();
    subscribeTopic(live(SELLER_SHOP_ID), handler);
    stream.open();
    stream.reconnect(true);
    expect(handler).toHaveBeenCalledWith({ type: 'resync', data: null });
  });

  it('W04 AS-21: revoked drops that topic only and tells its handler', () => {
    const mine = vi.fn();
    const other = vi.fn();
    subscribeTopic(live(SELLER_SHOP_ID), mine);
    subscribeTopic(live(OTHER_SHOP_ID), other);
    stream.open();
    stream.revoked(live(SELLER_SHOP_ID));
    expect(mine).toHaveBeenCalledWith({ type: 'revoked', data: live(SELLER_SHOP_ID) });
    expect(other).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'revoked' }));
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(OTHER_SHOP_ID)]);
  });

  const refreshed = () => vi.spyOn(sessionApi, 'refresh').mockResolvedValue({ ok: true, kind: 'session', session: { user: { id: USER, email: null, role: 'USER' }, expiresAt: '2026-10-12T00:00:00.000Z' } });

  it('W04 AS-22: a final refusal refreshes the session once and recreates the stream with the topic', async () => {
    refreshed();
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    stream.open();
    stream.refuse();
    await vi.waitFor(() => expect(stream.opened()).toBe(2));
    expect(stream.connections()).toBe(1);
    expect(stream.topics()).toEqual([live(SELLER_SHOP_ID)]);
    expect(sessionApi.refresh).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-22: a second refusal without an open between runs the session check, not a loop', async () => {
    refreshed();
    subscribeTopic(live(SELLER_SHOP_ID), vi.fn());
    stream.open();
    stream.refuse();
    await vi.waitFor(() => expect(stream.opened()).toBe(2));
    stream.refuse();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(sessionApi.refresh).toHaveBeenCalledTimes(1);
    expect(stream.opened()).toBe(2);
  });

  describe('parseLiveFrame', () => {
    it('W04 AS-19: unwraps the hub {topic, data} envelope and validates the frame', () => {
      const frame = liveFrameFixture();
      expect(parseLiveFrame({ topic: live(SELLER_SHOP_ID), data: frame })).toEqual(frame);
    });

    it('W04 AS-19: accepts the bare frame too', () => {
      const frame = liveFrameFixture();
      expect(parseLiveFrame(frame)).toEqual(frame);
    });

    it.each([
      ['null', null],
      ['a string', 'x'],
      ['an unknown field', { ...liveFrameFixture(), extra: 1 }],
      ['60 points missing', { ...liveFrameFixture(), ordersPerSecond: [1, 2] }],
      ['an envelope around garbage', { topic: 't', data: { shopId: 1 } }],
    ])('W04 AS-19: %s is dropped (null), never thrown', (_label, input) => {
      expect(parseLiveFrame(input)).toBeNull();
    });
  });
});
