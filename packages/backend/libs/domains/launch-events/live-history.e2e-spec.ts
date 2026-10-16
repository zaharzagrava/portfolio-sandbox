import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4, v7 as uuidv7 } from 'uuid';
import {
  initialLiveState,
  liveHistoryPageSchema,
  reduceLive,
  type LiveClientEvent,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { waitFor } from '@app/test/utils/async-helpers';
import { createTopics, testKafka } from '@app/test/utils/kafka-test';
import {
  LiveCommentPosted,
  LiveCommentRemoved,
} from './application/events/live-events';
import { commentPk, minuteBucket } from './domain/live-history-keys';
import {
  createLiveApp,
  expectContract,
  expectProblem,
  type LiveTestApp,
} from './testing/live-test-kit';

const DAY_S = 86_400;
const frameworkTests: Record<string, () => Promise<void>> = {};

describe('Live stream: history, async moderation and consumers', () => {
  let t: LiveTestApp;
  let dynamo: DynamoService;

  beforeAll(async () => {
    t = await createLiveApp();
    dynamo = t.app.get(DynamoService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type Item = {
    SK: string;
    text?: string;
    removed?: boolean;
    removedReason?: string;
    expiresAtEpoch?: number;
    authorName?: string;
  };
  const itemsOf = async (streamId: string, atMs: number): Promise<Item[]> => {
    const res = await dynamo.doc.send(
      new QueryCommand({
        TableName: dynamo.table('LiveComments'),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': commentPk(streamId, atMs) },
      }),
    );
    return (res.Items ?? []) as Item[];
  };
  const posted = (
    streamId: string,
    at: number,
    text = `c ${at}`,
    id = uuidv7({ msecs: at }),
  ) =>
    LiveCommentPosted.create(streamId, 0, {
      streamId,
      commentId: id,
      authorId: v4(),
      authorName: 'viewer-aaaaaaaa',
      text,
      at,
    });
  const removed = (streamId: string, commentId: string, at: number) =>
    LiveCommentRemoved.create(streamId, 0, {
      streamId,
      commentId,
      at,
      reason: 'moderator',
      actorId: v4(),
    });
  const base = () => Date.UTC(2026, 9, 5, 15, 30, 10);

  // --- AS-43 ------------------------------------------------------------------------------------------------------

  it('S23 AS-43: 1,000 posted events over 3 minutes are stored under their minute bucket with a 30-day expiry, written in groups of at most 25', async () => {
    const streamId = v4();
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 1_000; i++)
      events.push(
        posted(streamId, base() + Math.floor(i / 334) * 60_000 + (i % 334)),
      );
    t.historyIo.calls = 0;
    await t.history.project(events);
    expect(t.historyIo.calls).toBe(1_000);
    expect(t.historyIo.maxParallel).toBeLessThanOrEqual(25);
    let stored = 0;
    for (let minute = 0; minute < 3; minute++) {
      const items = await itemsOf(streamId, base() + minute * 60_000);
      stored += items.length;
      const sample = events.find(
        (e) =>
          Math.floor(((e.payload.at as number) - base()) / 60_000) === minute,
      )!;
      const item = items.find((i) => i.SK === sample.payload.commentId)!;
      expect(item.expiresAtEpoch).toBe(
        Math.floor((sample.payload.at as number) / 1000) + 30 * DAY_S,
      );
      expect(items.map((i) => i.SK)).toEqual(
        [...items.map((i) => i.SK)].sort(),
      );
    }
    expect(stored).toBe(1_000);
  }, 120_000);

  it('S23 AS-43: throttled writes are retried with growing waits until stored', async () => {
    const streamId = v4();
    const events = Array.from({ length: 60 }, (_, i) =>
      posted(streamId, base() + i),
    );
    t.historyIo.throttleNext(40);
    await t.history.project(events);
    expect((await itemsOf(streamId, base())).length).toBe(60);
    expect(t.historyIo.calls).toBe(100);
  });

  it('S23 AS-43: when the retries run out the delivery fails (and is redelivered), nothing is dropped', async () => {
    const streamId = v4();
    const events = Array.from({ length: 5 }, (_, i) =>
      posted(streamId, base() + i),
    );
    t.historyIo.throttleNext(1_000_000);
    await expect(t.history.project(events)).rejects.toThrow(/throttled/);
    t.historyIo.throttleNext(0);
    await t.history.project(events);
    expect((await itemsOf(streamId, base())).length).toBe(5);
  }, 60_000);

  // --- AS-44 ------------------------------------------------------------------------------------------------------

  it('S23 AS-44: the same posted event twice leaves one item', async () => {
    const streamId = v4();
    const event = posted(streamId, base());
    await t.history.project([event]);
    await t.history.project([event, event]);
    const items = await itemsOf(streamId, base());
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe(event.payload.text);
  });

  it('S23 AS-44: a removal processed before its post still ends with the text and removed: true; the removal twice changes nothing', async () => {
    const streamId = v4();
    const post = posted(streamId, base(), 'late arrival');
    const removal = removed(streamId, post.payload.commentId as string, base());
    await t.history.project([removal]);
    await t.history.project([post]);
    await t.history.project([removal]);
    const [item] = await itemsOf(streamId, base());
    expect(item).toMatchObject({
      SK: post.payload.commentId,
      text: 'late arrival',
      removed: true,
      removedReason: 'moderator',
    });
  });

  it('S23 AS-44: a removal for a comment that never arrives leaves a marker without text that expires with the history', async () => {
    const streamId = v4();
    const orphan = uuidv7({ msecs: base() });
    await t.history.project([removed(streamId, orphan, base())]);
    const [marker] = await itemsOf(streamId, base());
    expect(marker.text).toBeUndefined();
    expect(marker.removed).toBe(true);
    expect(marker.expiresAtEpoch).toBe(Math.floor(base() / 1000) + 30 * DAY_S);
  });

  // --- AS-45 ------------------------------------------------------------------------------------------------------

  // Needs its own app (the consumer framework runs); registered in the second describe at the end of the file.
  const as45 = async () => {
    await createTopics([{ topic: 'live.events' }]);
    const framework = await createLiveApp({ broker: 'real', framework: true });
    try {
      const kafka = testKafka();
      const admin = kafka.admin();
      await admin.connect();
      await waitFor(
        async () => {
          const groups = (
            await admin.describeGroups([
              'live-comments-history',
              'live-moderation',
            ])
          ).groups;
          return groups.every(
            (g) => g.state === 'Stable' && g.members.length === 1,
          );
        },
        {
          timeoutMs: 60_000,
          intervalMs: 500,
          description: 'both consumer groups stable',
        },
      );
      await admin.disconnect();

      const streamId = v4();
      const at = Date.now();
      const good = posted(streamId, at, 'a perfectly fine comment');
      const missingText = posted(streamId, at + 1);
      delete (missingText.payload as Record<string, unknown>).text;
      const future = { ...posted(streamId, at + 2), version: 9 };
      const dlq = (consumer: string, reason: string) =>
        MetricsRegistry.value('dlq_total', { consumer, reason }) ?? 0;
      const before = {
        invalid: dlq('live-comments-history', 'INVALID_PAYLOAD'),
        unknown: dlq('live-comments-history', 'UNSUPPORTED_VERSION'),
        moderationInvalid: dlq('live-moderation', 'INVALID_PAYLOAD'),
        moderationUnknown: dlq('live-moderation', 'UNSUPPORTED_VERSION'),
      };
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({
        topic: 'live.events',
        messages: [good, missingText, future].map((e) => ({
          key: streamId,
          value: JSON.stringify(e),
        })),
      });
      await producer.disconnect();

      await waitFor(
        async () =>
          (await itemsOf(streamId, at)).some(
            (i) => i.SK === good.payload.commentId,
          ),
        {
          timeoutMs: 60_000,
          intervalMs: 200,
          description: 'the valid comment is stored',
        },
      );
      await waitFor(
        async () =>
          dlq('live-comments-history', 'INVALID_PAYLOAD') > before.invalid &&
          dlq('live-comments-history', 'UNSUPPORTED_VERSION') >
            before.unknown &&
          dlq('live-moderation', 'INVALID_PAYLOAD') >
            before.moderationInvalid &&
          dlq('live-moderation', 'UNSUPPORTED_VERSION') >
            before.moderationUnknown,
        {
          timeoutMs: 60_000,
          intervalMs: 200,
          description: 'both consumers dead-lettered both messages',
        },
      );
      const items = await itemsOf(streamId, at);
      expect(items.map((i) => i.SK)).toEqual([good.payload.commentId]);
    } finally {
      await framework.close();
    }
  };

  // --- AS-46 ------------------------------------------------------------------------------------------------------

  async function streamWithHistory() {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const users = await t.viewers(8);
    t.stores.limiter.down();
    const bucket = minuteBucket(t.clock.nowMs());
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(
        (await t.comment(stream.id, users[i], `comment ${i}`).expect(201)).body
          .id,
      );
    await t.removeComment(s, stream.id, ids[2]).expect(204);
    await t.history.project(t.sent);
    return { s, stream, ids, bucket };
  }

  it('S23 AS-46: a minute is listed ascending by id without the removed comment, anonymously', async () => {
    const { stream, ids, bucket } = await streamWithHistory();
    const res = await t
      .history_(stream.id, `?minute=${bucket}&limit=100`)
      .expect(200);
    const page = expectContract(liveHistoryPageSchema, res.body);
    expect(page.items.map((c) => c.id)).toEqual(ids.filter((_, i) => i !== 2));
    expect(page.nextCursor).toBeNull();
  });

  it('S23 AS-46: the cursor continues without duplicates or gaps', async () => {
    const { stream, ids, bucket } = await streamWithHistory();
    const seen: string[] = [];
    let cursor = '';
    for (let guard = 0; guard < 10; guard++) {
      const res = await t
        .history_(
          stream.id,
          `?minute=${bucket}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        )
        .expect(200);
      const page = expectContract(liveHistoryPageSchema, res.body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ids.filter((_, i) => i !== 2));
  });

  it('S23 AS-46: a minute outside the running period or in the future is 200 with no items; a scheduled stream is empty', async () => {
    const { s, stream } = await streamWithHistory();
    for (const minute of ['200001010000', '209912312359']) {
      const res = await t.history_(stream.id, `?minute=${minute}`).expect(200);
      expect(res.body.items).toEqual([]);
    }
    const scheduled = await t.createStream(s);
    const res = await t
      .history_(scheduled.id, `?minute=${minuteBucket(t.clock.nowMs())}`)
      .expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ['a malformed minute', '?minute=abc'],
    ['a missing minute', ''],
    ['an impossible minute', '?minute=202613451299'],
    ['a limit of 0', '?minute=202610051530&limit=0'],
    ['a limit over 200', '?minute=202610051530&limit=201'],
    ['a non-numeric limit', '?minute=202610051530&limit=many'],
  ])('S23 AS-46: %s is 422', async (_name, query) => {
    const { stream } = await streamWithHistory();
    const res = await t.history_(stream.id, query).expect(422);
    expect(expectProblem(res.body).errors?.length).toBeGreaterThan(0);
  });

  it('S23 AS-46: an unknown stream is 404', async () => {
    await t.history_(v4(), '?minute=202610051530').expect(404);
  });

  // --- AS-47 ------------------------------------------------------------------------------------------------------

  async function toxicComment(text: string, score: number) {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    t.classifier.scores.set(text, score);
    const res = await t.comment(stream.id, await t.viewer(), text).expect(201);
    return { stream, comment: res.body };
  }
  const removals = () =>
    t.sent.filter((e) => e.type === 'live.comment_removed');

  it('S23 AS-47: a comment the classifier scores 0.7 or higher is removed within a second at p95, once, with reason auto and the score', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 20; i++) {
      t.sent.length = 0;
      const { stream, comment } = await toxicComment(
        `toxic ${i}`,
        0.7 + i / 100,
      );
      const event = t.sent.find((e) => e.type === 'live.comment_posted')!;
      const start = Date.now();
      await t.moderation.project([event]);
      durations.push(Date.now() - start);
      const recent = expectContract(
        (await import('@marketplace-sandbox/contracts')).liveSnapshotSchema,
        (await t.snapshot(stream.id).expect(200)).body,
      ).recent;
      expect(recent.map((c) => c.id)).not.toContain(comment.id);
      expect(
        t.published.some(
          (p) =>
            p.type === 'comment_removed' &&
            (p.data as { id: string }).id === comment.id,
        ),
      ).toBe(true);
      expect(removals()).toHaveLength(1);
      expect(removals()[0].payload).toMatchObject({
        reason: 'auto',
        commentId: comment.id,
        score: 0.7 + i / 100,
      });
    }
    durations.sort((a, b) => a - b);
    expect(
      durations[Math.floor(durations.length * 0.95) - 1],
    ).toBeLessThanOrEqual(1_000);
  });

  it('S23 AS-47: a score below 0.7 changes nothing; the same event twice makes one removal', async () => {
    const calm = await toxicComment('quite calm', 0.69);
    await t.moderation.project(
      t.sent.filter((e) => e.type === 'live.comment_posted'),
    );
    expect(removals()).toHaveLength(0);
    expect(
      expectContract(
        (await import('@marketplace-sandbox/contracts')).liveSnapshotSchema,
        (await t.snapshot(calm.stream.id).expect(200)).body,
      ).recent,
    ).toHaveLength(1);

    t.sent.length = 0;
    await toxicComment('very toxic', 0.95);
    const event = t.sent.find((e) => e.type === 'live.comment_posted')!;
    await t.moderation.project([event]);
    await t.moderation.project([event, event]);
    expect(removals()).toHaveLength(1);
  });

  it('S23 AS-47: a classifier that times out is a failure of the delivery, counted, and the comment stays visible', async () => {
    const { stream, comment } = await toxicComment('anything', 0);
    const event = t.sent.find((e) => e.type === 'live.comment_posted')!;
    t.classifier.mode = 'hang';
    const before = MetricsRegistry.value('live_moderation_failed_total') ?? 0;
    await expect(t.moderation.project([event])).rejects.toThrow(
      /classifier failed/,
    );
    expect(MetricsRegistry.value('live_moderation_failed_total')).toBe(
      before + 1,
    );
    expect(removals()).toHaveLength(0);
    const recent = (await t.snapshot(stream.id).expect(200)).body.recent as {
      id: string;
    }[];
    expect(recent.map((c) => c.id)).toContain(comment.id);
  }, 30_000);

  const as47 = async () => {
    await createTopics([{ topic: 'live.events' }]);
    const framework = await createLiveApp({ broker: 'real', framework: true });
    try {
      const kafka = testKafka();
      const admin = kafka.admin();
      await admin.connect();
      await waitFor(
        async () =>
          (
            await admin.describeGroups([
              'live-comments-history',
              'live-moderation',
            ])
          ).groups.every((g) => g.state === 'Stable' && g.members.length === 1),
        {
          timeoutMs: 60_000,
          intervalMs: 500,
          description: 'both consumer groups stable',
        },
      );
      await admin.disconnect();
      framework.classifier.mode = 'fail';
      const dlq = () =>
        MetricsRegistry.value('dlq_total', {
          consumer: 'live-moderation',
          reason: 'HANDLER_FAILED',
        }) ?? 0;
      const failed = () =>
        MetricsRegistry.value('live_moderation_failed_total') ?? 0;
      const [dlqBefore, failedBefore] = [dlq(), failed()];
      const s = await framework.seller();
      const stream = await framework.liveStream(s);
      const comment = (
        await framework
          .comment(stream.id, await framework.viewer(), 'will be stored')
          .expect(201)
      ).body;
      const dynamoService = framework.app.get(DynamoService);
      await waitFor(
        async () => {
          const res = await dynamoService.doc.send(
            new QueryCommand({
              TableName: dynamoService.table('LiveComments'),
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: {
                ':pk': commentPk(stream.id, comment.at),
              },
            }),
          );
          return (res.Items ?? []).length === 1;
        },
        {
          timeoutMs: 60_000,
          intervalMs: 200,
          description: 'history stored the comment',
        },
      );
      await waitFor(async () => dlq() > dlqBefore, {
        timeoutMs: 60_000,
        intervalMs: 200,
        description: 'the failed event is dead-lettered',
      });
      expect(failed() - failedBefore).toBeGreaterThanOrEqual(3);
      const recent = (await framework.snapshot(stream.id).expect(200)).body
        .recent as { id: string }[];
      expect(recent.map((c) => c.id)).toContain(comment.id);
    } finally {
      await framework.close();
    }
  };

  // --- AS-48 ------------------------------------------------------------------------------------------------------

  it('S23 AS-48: a delivered comment that is removed afterwards is dropped by the viewer’s reducer; a later snapshot and the history never contain it', async () => {
    const s = await t.seller();
    const stream = await t.liveStream(s);
    const viewer = await t.viewer();
    const watcher = await t.connect(stream.id);
    await watcher.waitFor((f) => f.some((x) => x.event === 'snapshot'));
    const c = (await t.comment(stream.id, viewer, 'regrettable').expect(201))
      .body;
    await t.fed(stream.id, 1);
    t.window();
    await watcher.waitFor((f) => f.some((x) => x.event === 'comments'));
    await t.removeComment(s, stream.id, c.id).expect(204);
    await watcher.waitFor((f) => f.some((x) => x.event === 'comment_removed'));
    const state = watcher.events.reduce(
      (acc, e) =>
        reduceLive(acc, {
          type: e.event,
          data: JSON.parse(e.data!),
        } as LiveClientEvent),
      initialLiveState(),
    );
    expect(state.comments).toEqual([]);
    expect(state.removed).toEqual([c.id]);
    watcher.close();

    await t.history.project(t.sent);
    const later = await t.connect(stream.id);
    await later.waitFor((f) => f.some((x) => x.event === 'snapshot'));
    expect(JSON.parse(later.events[0].data!).recent).toEqual([]);
    later.close();
    const page = await t
      .history_(stream.id, `?minute=${minuteBucket(c.at)}`)
      .expect(200);
    expect(page.body.items).toEqual([]);
  });

  frameworkTests.as45 = as45;
  frameworkTests.as47 = as47;
});

// The two scenarios that need the real consumer framework run in an app of their own, after the first app is closed.
describe('Live stream: history, async moderation and consumers (consumer framework)', () => {
  it(
    'S23 AS-45: an invalid or unknown-version message among valid ones is dead-lettered by both consumers without a write, and the valid ones are processed',
    frameworkTests.as45,
    180_000,
  );
  it(
    'S23 AS-47: through the consumer framework a failing classifier is retried 3 times, then dead-lettered and counted, while the history writer carries on',
    frameworkTests.as47,
    180_000,
  );
});
