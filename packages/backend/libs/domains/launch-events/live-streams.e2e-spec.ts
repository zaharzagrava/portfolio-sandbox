import { v4 } from 'uuid';
import {
  liveCommentSchema,
  liveSnapshotSchema,
  liveStreamSchema,
  pinSchema,
} from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { inParallel } from '@app/test/utils/async-helpers';
import {
  createLiveApp,
  expectContract,
  expectProblem,
  type Actor,
  type LiveTestApp,
  type Seller,
} from './testing/live-test-kit';

/** Runs the rounds of a repeated test five at a time (each round uses data of its own). */
const eachRound = async (
  rounds: number,
  body: (round: number) => Promise<void>,
  size = 5,
): Promise<void> => {
  for (let from = 0; from < rounds; from += size)
    await Promise.all(
      Array.from({ length: Math.min(size, rounds - from) }, (_, k) =>
        body(from + k),
      ),
    );
};

describe('Live stream: lifecycle, authorization and pinned commerce', () => {
  let t: LiveTestApp;
  let redis: RedisService;

  beforeAll(async () => {
    t = await createLiveApp();
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const wipeFastStore = async () => {
    const keys = await redis.client.keys('live:*');
    if (keys.length > 0) await redis.client.del(...keys);
  };
  const pinsPublished = () => t.published.filter((p) => p.type === 'pin');
  const eventsOf = (type: string) => t.sent.filter((e) => e.type === type);
  const staff = (s: Seller) => ({ id: s.id, auth: s.auth, shopId: s.shopId });

  // --- AS-33 ------------------------------------------------------------------------------------------------------

  it('S23 AS-33: a member with products.write creates a stream: 201, the contract document, the row persisted', async () => {
    const s = await t.seller();
    const launchEventId = v4();
    const res = await t
      .http()
      .post(`/api/shops/${s.shopId}/live`)
      .set(s.auth)
      .send({ title: 'Product reveal', launchEventId })
      .expect(201);
    const stream = expectContract(liveStreamSchema, res.body);
    expect(stream).toMatchObject({
      shopId: s.shopId,
      title: 'Product reveal',
      status: 'SCHEDULED',
      launchEventId,
      startedAt: null,
      endedAt: null,
    });
    const rows = await t.rows<{ shopId: string; status: string }>(
      `SELECT "shopId", status FROM "LiveStream" WHERE id = :id`,
      { id: stream.id },
    );
    expect(rows).toEqual([{ shopId: s.shopId, status: 'SCHEDULED' }]);
  });

  it.each([
    ['too short', { title: 'ab' }],
    ['too long', { title: 'x'.repeat(121) }],
    ['missing', {}],
    ['not a string', { title: 7 }],
    ['launchEventId not a UUID', { title: 'Reveal', launchEventId: 'nope' }],
    ['unknown property', { title: 'Reveal', extra: true }],
  ])(
    'S23 AS-33: a title or body that is %s is 422 with errors[]',
    async (_n, body) => {
      const s = await t.seller();
      const res = await t
        .http()
        .post(`/api/shops/${s.shopId}/live`)
        .set(s.auth)
        .send(body)
        .expect(422);
      expect(expectProblem(res.body).errors?.length).toBeGreaterThan(0);
    },
  );

  it('S23 AS-33: 120 characters is accepted; a non-member gets 404, a read-only member 403, no credentials 401', async () => {
    const s = await t.seller();
    await t
      .http()
      .post(`/api/shops/${s.shopId}/live`)
      .set(s.auth)
      .send({ title: 'x'.repeat(120) })
      .expect(201);
    const outsider = await t.viewer();
    const reader = await t.member(s.shopId, 'VIEWER');
    await t
      .http()
      .post(`/api/shops/${s.shopId}/live`)
      .set(outsider.auth)
      .send({ title: 'Reveal' })
      .expect(404);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/live`)
      .set(reader.auth)
      .send({ title: 'Reveal' })
      .expect(403);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/live`)
      .send({ title: 'Reveal' })
      .expect(401);
    const owned = await t.rows(
      `SELECT id FROM "LiveStream" WHERE "shopId" = :shopId`,
      { shopId: s.shopId },
    );
    expect(owned).toHaveLength(1);
  });

  // --- AS-34 ------------------------------------------------------------------------------------------------------

  it('S23 AS-34: start moves SCHEDULED to LIVE once: startedAt set, status event, one live.stream_started on the outbox', async () => {
    const s = await t.seller();
    const stream = await t.createStream(s);
    const res = await t.start(s, stream.id).expect(200);
    const live = expectContract(liveStreamSchema, res.body);
    expect(live.status).toBe('LIVE');
    expect(live.startedAt).not.toBeNull();
    expect(
      t.published.filter(
        (p) => p.topic === `stream:${stream.id}` && p.type === 'status',
      ),
    ).toEqual([
      {
        topic: `stream:${stream.id}`,
        type: 'status',
        data: { status: 'LIVE' },
      },
    ]);
    const rows = (await t.outbox(stream.id)).filter(
      (r) => r.type === 'live.stream_started',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('launch_events.events');
    expect(rows[0].payload.payload).toMatchObject({
      streamId: stream.id,
      shopId: s.shopId,
      title: stream.title,
    });
  });

  it('S23 AS-34: 20 concurrent starts make one transition and one event; every response is 200 with the current stream', async () => {
    for (let round = 0; round < 3; round++) {
      const s = await t.seller();
      const stream = await t.createStream(s);
      const results = await inParallel(20, () => t.start(s, stream.id));
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
        const res = (
          r as PromiseFulfilledResult<{
            status: number;
            body: { status: string };
          }>
        ).value;
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('LIVE');
      }
      const started = (await t.outbox(stream.id)).filter(
        (r) => r.type === 'live.stream_started',
      );
      expect(started).toHaveLength(1);
    }
  });

  it('S23 AS-34: end moves LIVE to ENDED once: endedAt set, pin cleared, status event, one live.stream_ended with the duration', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    await t.advance(90_000);
    const res = await t.end(s, stream.id).expect(200);
    const ended = expectContract(liveStreamSchema, res.body);
    expect(ended.status).toBe('ENDED');
    expect(ended.endedAt).not.toBeNull();
    await t.end(s, stream.id).expect(200);
    const rows = (await t.outbox(stream.id)).filter(
      (r) => r.type === 'live.stream_ended',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.payload).toMatchObject({
      streamId: stream.id,
      shopId: s.shopId,
      durationSeconds: 90,
    });
    expect(
      t.published.filter(
        (p) => p.type === 'status' && p.data.status === 'ENDED',
      ),
    ).toHaveLength(1);
  });

  it('S23 AS-34: ending clears the pin and keeps the version', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    await t
      .pin(s, stream.id, { productId: product.id, text: 'Buy now' })
      .expect(200);
    await t.end(s, stream.id).expect(200);
    const [row] = await t.rows<{ pin: unknown; pinVersion: number }>(
      `SELECT pin, "pinVersion" FROM "LiveStream" WHERE id = :id`,
      { id: stream.id },
    );
    expect(row.pin).toBeNull();
    expect(row.pinVersion).toBe(1);
  });

  it('S23 AS-34: start after end is 409 stream_ended; ending a scheduled stream cancels it (startedAt null, duration 0)', async () => {
    const s = await t.seller();
    const ended = await t.liveStream(s);
    await t.end(s, ended.id).expect(200);
    const res = await t.start(s, ended.id).expect(409);
    expect(expectProblem(res.body).code).toBe('stream_ended');

    const scheduled = await t.createStream(s);
    const cancelled = await t.end(s, scheduled.id).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'ENDED', startedAt: null });
    const rows = (await t.outbox(scheduled.id)).filter(
      (r) => r.type === 'live.stream_ended',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.payload).toMatchObject({ durationSeconds: 0 });
  });

  it('S23 AS-34: an outbox that refuses the event leaves the status unchanged and answers 503', async () => {
    const s = await t.seller();
    const stream = await t.createStream(s);
    t.stores.outbox.down();
    const res = await t.start(s, stream.id).expect(503);
    expect(expectProblem(res.body).code).toBe('live_unavailable');
    t.stores.outbox.up();
    const [row] = await t.rows<{ status: string }>(
      `SELECT status FROM "LiveStream" WHERE id = :id`,
      { id: stream.id },
    );
    expect(row.status).toBe('SCHEDULED');
    await t.start(s, stream.id).expect(200);
  });

  // --- AS-35 ------------------------------------------------------------------------------------------------------

  it('S23 AS-35: staff of shop A cannot reach a stream of shop B on any staff route: 404, indistinguishable from unknown, B unchanged', async () => {
    const a = await t.seller();
    const b = await t.seller();
    const foreign = await t.liveStream(b);
    const product = await t.product(a.shopId);
    const target = await t.viewer();
    const call = (id: string) => [
      () => t.start(a, id),
      () => t.end(a, id),
      () => t.pin(a, id, { productId: product.id, text: 'Buy now' }),
      () => t.unpin(a, id),
      () => t.removeComment(a, id, v4()),
      () => t.mute(a, id, target.id),
      () => t.unmute(a, id, target.id),
    ];
    const unknown = call(v4());
    const crossing = call(foreign.id);
    for (let i = 0; i < crossing.length; i++) {
      const x = await crossing[i]();
      const u = await unknown[i]();
      expect(x.status).toBe(404);
      const px = expectProblem(x.body);
      const pu = expectProblem(u.body);
      expect([px.code, px.title, px.detail, px.type]).toEqual([
        pu.code,
        pu.title,
        pu.detail,
        pu.type,
      ]);
      expect(px.code).toBe('stream_not_found');
    }
    // and with B's shop id in the path, the guard answers 404 as well
    await t.start({ ...a, shopId: b.shopId }, foreign.id).expect(404);
    const [row] = await t.rows<{ status: string; pinVersion: number }>(
      `SELECT status, "pinVersion" FROM "LiveStream" WHERE id = :id`,
      { id: foreign.id },
    );
    expect(row).toEqual({ status: 'LIVE', pinVersion: 0 });
  });

  // --- AS-36 ------------------------------------------------------------------------------------------------------

  it('S23 AS-36: pin returns the contract document, viewers get a pin event, the snapshot has it, a wipe of the fast store keeps it', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId, { title: 'Phone X' });
    const res = await t
      .pin(s, stream.id, {
        productId: product.id,
        text: 'Buy now — 500 left',
        stockLeft: 500,
      })
      .expect(200);
    const pin = expectContract(pinSchema, res.body);
    expect(pin).toMatchObject({
      version: 1,
      productId: product.id,
      productTitle: 'Phone X',
      text: 'Buy now — 500 left',
      stockLeft: 500,
    });
    expect(pinsPublished()).toEqual([
      { topic: `stream:${stream.id}`, type: 'pin', data: pin },
    ]);

    const snapshot = expectContract(
      liveSnapshotSchema,
      (await t.snapshot(stream.id).expect(200)).body,
    );
    expect(snapshot.pin).toEqual(pin);
    await wipeFastStore();
    const again = expectContract(
      liveSnapshotSchema,
      (await t.snapshot(stream.id).expect(200)).body,
    );
    expect(again.pin).toEqual(pin);
  });

  it('S23 AS-36: each change adds 1 to the version; the identical body keeps the version and sends no event', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const body = { productId: product.id, text: 'Buy now', stockLeft: 10 };
    const first = await t.pin(s, stream.id, body).expect(200);
    const same = await t.pin(s, stream.id, body).expect(200);
    expect(same.body.version).toBe(first.body.version);
    expect(pinsPublished()).toHaveLength(1);
    const changed = await t
      .pin(s, stream.id, { ...body, text: 'Last chance' })
      .expect(200);
    expect(changed.body.version).toBe(2);
    const stock = await t
      .pin(s, stream.id, { ...body, text: 'Last chance', stockLeft: 3 })
      .expect(200);
    expect(stock.body.version).toBe(3);
    expect(pinsPublished()).toHaveLength(3);
  });

  // --- AS-37 ------------------------------------------------------------------------------------------------------

  it('S23 AS-37: an unknown, a foreign and an archived product are refused alike with 422 product_not_pinnable', async () => {
    const s = await t.seller();
    const other = await t.seller();
    const stream = await t.liveStream(s);
    const foreign = await t.product(other.shopId);
    const archived = await t.product(s.shopId, { status: 'ARCHIVED' });
    const answers: string[][] = [];
    for (const productId of [v4(), foreign.id, archived.id]) {
      const res = await t
        .pin(s, stream.id, { productId, text: 'Buy now' })
        .expect(422);
      const p = expectProblem(res.body);
      answers.push([p.code, p.title, p.detail]);
    }
    expect(answers[0][0]).toBe('product_not_pinnable');
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(pinsPublished()).toHaveLength(0);
  });

  it.each([
    ['empty text', { text: '' }],
    ['text over 80 characters', { text: 'x'.repeat(81) }],
    ['negative stockLeft', { text: 'Buy', stockLeft: -1 }],
    ['fractional stockLeft', { text: 'Buy', stockLeft: 1.5 }],
    ['stockLeft above a million', { text: 'Buy', stockLeft: 1_000_001 }],
    ['unknown property', { text: 'Buy', price: 1 }],
  ])('S23 AS-37: %s is 422', async (_name, extra) => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const res = await t
      .pin(s, stream.id, { productId: product.id, ...extra })
      .expect(422);
    expect(expectProblem(res.body).errors?.length).toBeGreaterThan(0);
  });

  it('S23 AS-37: 80 characters and a million are accepted; a malformed productId is 400; the payload carries no price', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const ok = await t
      .pin(s, stream.id, {
        productId: product.id,
        text: 'x'.repeat(80),
        stockLeft: 1_000_000,
      })
      .expect(200);
    expect(Object.keys(ok.body).sort()).toEqual([
      'pinnedAt',
      'productId',
      'productTitle',
      'stockLeft',
      'text',
      'version',
    ]);
    await t.pin(s, stream.id, { productId: 'nope', text: 'Buy' }).expect(400);
  });

  it('S23 AS-37: a SCHEDULED or ENDED stream cannot be pinned: 409 stream_not_live', async () => {
    const s = await t.seller();
    const product = await t.product(s.shopId);
    const scheduled = await t.createStream(s);
    const ended = await t.liveStream(s);
    await t.end(s, ended.id).expect(200);
    for (const id of [scheduled.id, ended.id]) {
      const res = await t
        .pin(s, id, { productId: product.id, text: 'Buy' })
        .expect(409);
      expect(expectProblem(res.body).code).toBe('stream_not_live');
    }
  });

  // --- AS-38 ------------------------------------------------------------------------------------------------------

  it('S23 AS-38: unpin answers 204 with a pin event of the next version; the snapshot shows pin null; unpinning an empty pin is 204 without an event', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    await t
      .pin(s, stream.id, { productId: product.id, text: 'Buy' })
      .expect(200);
    t.published.length = 0;
    await t.unpin(s, stream.id).expect(204);
    expect(pinsPublished()).toEqual([
      {
        topic: `stream:${stream.id}`,
        type: 'pin',
        data: { version: 2, unpinned: true },
      },
    ]);
    const snapshot = expectContract(
      liveSnapshotSchema,
      (await t.snapshot(stream.id).expect(200)).body,
    );
    expect(snapshot.pin).toBeNull();
    expect(snapshot.pinVersion).toBe(2);
    await t.unpin(s, stream.id).expect(204);
    expect(pinsPublished()).toHaveLength(1);
  });

  it('S23 AS-38: two staff pinning different products at the same instant get distinct consecutive versions, 20 times', async () => {
    const s = await t.seller();
    const second = await t.member(s.shopId, 'STAFF');
    const stream = await t.liveStream(s);
    const [p1, p2] = [await t.product(s.shopId), await t.product(s.shopId)];
    let last = 0;
    for (let round = 0; round < 20; round++) {
      const results = await inParallel(2, (i) =>
        t.pin(i === 0 ? s : { ...second, shopId: s.shopId }, stream.id, {
          productId: i === 0 ? p1.id : p2.id,
          text: `round ${round} ${i}`,
        }),
      );
      const versions = results
        .map(
          (r) =>
            (
              r as PromiseFulfilledResult<{
                status: number;
                body: { version: number; productId: string };
              }>
            ).value,
        )
        .map((v) => {
          expect(v.status).toBe(200);
          return v.body.version;
        })
        .sort((a, b) => a - b);
      expect(versions).toEqual([last + 1, last + 2]);
      last += 2;
    }
    const [row] = await t.rows<{ pinVersion: number; pin: { text: string } }>(
      `SELECT "pinVersion", pin FROM "LiveStream" WHERE id = :id`,
      { id: stream.id },
    );
    expect(row.pinVersion).toBe(40);
    // the stored pin is the one the higher version belongs to: the last event published with version 40
    const top = pinsPublished()
      .map((p) => p.data as { version: number; text: string })
      .find((d) => d.version === 40);
    expect(row.pin.text).toBe(top?.text);
  });

  // --- AS-39 ------------------------------------------------------------------------------------------------------

  const postComment = async (
    streamId: string,
    who: Actor,
    text = 'Hello there',
  ) => {
    const res = await t.comment(streamId, who, text).expect(201);
    return expectContract(liveCommentSchema, res.body);
  };

  it('S23 AS-39: removing a comment is 204; it leaves the recent list and snapshots, viewers get comment_removed, one live.comment_removed v2 is on the event stream', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    const keep = await postComment(stream.id, viewer, 'keep me');
    const drop = await postComment(stream.id, viewer, 'drop me');
    await t.removeComment(s, stream.id, drop.id).expect(204);

    const snapshot = expectContract(
      liveSnapshotSchema,
      (await t.snapshot(stream.id).expect(200)).body,
    );
    expect(snapshot.recent.map((c) => c.id)).toEqual([keep.id]);
    expect(
      t.published.filter(
        (p) =>
          p.type === 'comment_removed' && p.topic === `stream:${stream.id}`,
      ),
    ).toEqual([
      {
        topic: `stream:${stream.id}`,
        type: 'comment_removed',
        data: { id: drop.id },
      },
    ]);
    const removed = eventsOf('live.comment_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ version: 2, aggregateId: stream.id });
    expect(removed[0].payload).toMatchObject({
      streamId: stream.id,
      commentId: drop.id,
      reason: 'moderator',
      actorId: s.id,
    });
  });

  it('S23 AS-39: a repeat and 20 concurrent removals are 204 each and still one event, 20 times over', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    await eachRound(20, async (round) => {
      const c = await postComment(
        stream.id,
        await t.viewer(),
        `comment ${round}`,
      );
      const results = await inParallel(20, () =>
        t.removeComment(s, stream.id, c.id),
      );
      for (const r of results)
        expect(
          (r as PromiseFulfilledResult<{ status: number }>).value.status,
        ).toBe(204);
      await t.removeComment(s, stream.id, c.id).expect(204);
    });
    expect(eventsOf('live.comment_removed')).toHaveLength(20);
  });

  it('S23 AS-39: a comment that aged out of the recent list but is in the history is removed the same way', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    const c = await postComment(stream.id, viewer, 'old news');
    await t.history.project(eventsOf('live.comment_posted'));
    await redis.client.del(`live:{${stream.id}}:recent`);
    await t.removeComment(s, stream.id, c.id).expect(204);
    expect(eventsOf('live.comment_removed')).toHaveLength(1);
  });

  it('S23 AS-39: an unknown comment, a comment of another stream and a malformed id are refused', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const other = await t.liveStream(s);
    const viewer = await t.viewer();
    const elsewhere = await postComment(other.id, viewer);
    const unknown = await t.removeComment(s, stream.id, v4()).expect(404);
    expect(expectProblem(unknown.body).code).toBe('comment_not_found');
    const foreign = await t
      .removeComment(s, stream.id, elsewhere.id)
      .expect(404);
    expect(expectProblem(foreign.body).code).toBe('comment_not_found');
    await t.removeComment(s, stream.id, 'nope').expect(400);
    expect(eventsOf('live.comment_removed')).toHaveLength(0);
  });

  it('S23 AS-39: an event stream that refuses writes leaves the comment visible with 503; the retry completes with one event', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    const c = await postComment(stream.id, viewer);
    t.stores.events.down();
    const res = await t.removeComment(s, stream.id, c.id).expect(503);
    expect(expectProblem(res.body).code).toBe('live_unavailable');
    const before = expectContract(
      liveSnapshotSchema,
      (await t.snapshot(stream.id).expect(200)).body,
    );
    expect(before.recent.map((x) => x.id)).toEqual([c.id]);
    t.stores.events.up();
    await t.removeComment(s, stream.id, c.id).expect(204);
    expect(eventsOf('live.comment_removed')).toHaveLength(1);
  });

  // --- AS-40 ------------------------------------------------------------------------------------------------------

  it('S23 AS-40: mute is 204 and idempotent, unmute is 204 (also for a user who is not muted); a muted user still watches and reacts', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const troll = await t.viewer();
    await t.mute(s, stream.id, troll.id).expect(204);
    await t.mute(s, stream.id, troll.id).expect(204);
    const rows = await t.rows(
      `SELECT "userId" FROM "LiveMute" WHERE "streamId" = :id`,
      { id: stream.id },
    );
    expect(rows).toHaveLength(1);
    await t.react(stream.id, troll, { '❤️': 1 }).expect(202);
    const watching = await t.connect(stream.id, troll);
    expect(watching.status).toBe(200);
    watching.close();
    await t.unmute(s, stream.id, troll.id).expect(204);
    await t.unmute(s, stream.id, troll.id).expect(204);
    expect(
      await t.rows(`SELECT "userId" FROM "LiveMute" WHERE "streamId" = :id`, {
        id: stream.id,
      }),
    ).toHaveLength(0);
  });

  it('S23 AS-40: staff cannot be muted (422 cannot_mute_staff); an id unknown to identity is 204', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const colleague = await t.member(s.shopId, 'STAFF');
    const admin = await t.member(s.shopId, 'ADMIN');
    for (const target of [s.id, colleague.id, admin.id]) {
      const res = await t.mute(s, stream.id, target).expect(422);
      expect(expectProblem(res.body).code).toBe('cannot_mute_staff');
    }
    await t.mute(s, stream.id, v4()).expect(204);
    const reader = await t.member(s.shopId, 'VIEWER');
    await t.mute(s, stream.id, reader.id).expect(204);
  });

  // --- AS-41 ------------------------------------------------------------------------------------------------------

  it('S23 AS-41: pin, unpin, remove, mute and unmute answer 401 anonymous, 404 non-member, 403 read-only member; nothing changes', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const product = await t.product(s.shopId);
    const target = await t.viewer();
    const outsider = await t.viewer();
    const reader = await t.member(s.shopId, 'VIEWER');
    const base = `/api/shops/${s.shopId}/live/${stream.id}`;
    const routes: [string, string, object?][] = [
      ['put', `${base}/pin`, { productId: product.id, text: 'Buy' }],
      ['delete', `${base}/pin`],
      ['delete', `${base}/comments/${v4()}`],
      ['post', `${base}/mutes/${target.id}`],
      ['delete', `${base}/mutes/${target.id}`],
    ];
    const as = (
      who: Actor | null,
      [method, url, body]: [string, string, object?],
    ) => {
      const req = (
        t.http() as unknown as Record<
          string,
          (u: string) => import('supertest').Test
        >
      )[method](url);
      return (who ? req.set(who.auth) : req).send(body);
    };
    for (const route of routes) {
      expect((await as(null, route)).status).toBe(401);
      expect((await as(outsider, route)).status).toBe(404);
      expect((await as(reader, route)).status).toBe(403);
    }
    const [row] = await t.rows<{ pinVersion: number }>(
      `SELECT "pinVersion" FROM "LiveStream" WHERE id = :id`,
      { id: stream.id },
    );
    expect(row.pinVersion).toBe(0);
    expect(
      await t.rows(`SELECT 1 FROM "LiveMute" WHERE "streamId" = :id`, {
        id: stream.id,
      }),
    ).toHaveLength(0);
  });

  it.each([
    ['SUSPENDED', 403, 'shop_suspended'],
    ['DELETING', 409, 'shop_offboarding'],
  ] as const)(
    'S23 AS-41: staff writes of a %s shop answer %i %s (create, start, pin, mute)',
    async (status, httpStatus, code) => {
      const s = await t.seller({ status });
      const product = await t.product(s.shopId);
      const [{ id }] = await t.rows<{ id: string }>(
        `INSERT INTO "LiveStream" ("shopId", title) VALUES (:shopId, 'Closed shop') RETURNING id`,
        { shopId: s.shopId },
      );
      const target = await t.viewer();
      const answers = [
        await t
          .http()
          .post(`/api/shops/${s.shopId}/live`)
          .set(s.auth)
          .send({ title: 'Reveal' }),
        await t.start(s, id),
        await t.pin(s, id, { productId: product.id, text: 'Buy' }),
        await t.mute(s, id, target.id),
      ];
      for (const res of answers) {
        expect(res.status).toBe(httpStatus);
        expect(expectProblem(res.body).code).toBe(code);
      }
    },
  );

  // --- AS-42 ------------------------------------------------------------------------------------------------------

  it('S23 AS-42: the public snapshot is the contract document with Cache-Control public, s-maxage=1, anonymous', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const res = await t.snapshot(stream.id).expect(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=1');
    const snapshot = expectContract(liveSnapshotSchema, res.body);
    expect(snapshot).toMatchObject({
      id: stream.id,
      shopId: s.shopId,
      status: 'LIVE',
      pin: null,
      recent: [],
    });
    expect(snapshot.degraded).toBeUndefined();
  });

  it('S23 AS-42: an unknown stream is 404 stream_not_found, a malformed id 400', async () => {
    const unknown = await t.snapshot(v4()).expect(404);
    expect(expectProblem(unknown.body).code).toBe('stream_not_found');
    await t.snapshot('nope').expect(400);
  });

  it('S23 AS-42: 1,000 concurrent anonymous reads cost at most one relational read', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    await t.state.evict(stream.id);
    t.queries.count = 0;
    const results = await inParallel(1_000, () => t.snapshot(stream.id));
    const statuses = results.map(
      (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
    );
    expect(statuses.filter((n) => n === 200).length).toBeGreaterThan(0);
    expect(statuses.every((n) => n === 200 || n === 429)).toBe(true);
    expect(t.queries.count).toBeLessThanOrEqual(1);
  });

  it('S23 AS-42: the address limit answers 429 with Retry-After after 120 reads a minute, and a limiter that is down lets reads through', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    // all 120 reads are allowed, so they go 20 at a time; the 121st still comes after every one of them
    for (let from = 0; from < 120; from += 20)
      await Promise.all(
        Array.from({ length: 20 }, () => t.snapshot(stream.id).expect(200)),
      );
    const limited = await t.snapshot(stream.id).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    t.stores.limiter.down();
    await t.snapshot(stream.id).expect(200);
  });
});
