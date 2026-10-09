import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { context, trace } from '@opentelemetry/api';
import { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { InboxService } from '@app/infrastructure/inbox/inbox.service';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { SqsTaskQueue } from './sqs-task-queue';
import { InMemoryTaskQueue } from './in-memory-task-queue';
import { InvalidEnqueueOptionsError } from './enqueue-options';
import { TaskQueue, TaskMessage } from './task-queue.port';

const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:9424';
const PREFIX =
  process.env.SQS_QUEUE_URL_PREFIX ?? 'http://localhost:9424/000000000000/';
const RUN = uuidv7().slice(-8);

const raw = new SQSClient({
  region: 'eu-central-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const config = {
  get: (key: string) =>
    ({
      sqs_endpoint: ENDPOINT,
      sqs_queue_url_prefix: PREFIX,
      aws_region: 'eu-central-1',
    })[key],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

const created: string[] = [];
const stops: (() => Promise<void>)[] = [];

/** Creates `<name>-<run>` (and, with `maxReceiveCount`, its dead-letter queue) and returns the names. */
async function makeQueue(
  name: string,
  opts: { fifo?: boolean; visibility?: number; maxReceiveCount?: number } = {},
) {
  const suffix = opts.fifo ? '.fifo' : '';
  const queue = `s53-${name}-${RUN}${suffix}`;
  const dlq = `s53-${name}-${RUN}-dlq${suffix}`;
  const fifoAttrs = opts.fifo ? { FifoQueue: 'true' } : {};
  await raw.send(
    new CreateQueueCommand({ QueueName: dlq, Attributes: fifoAttrs }),
  );
  created.push(dlq);
  const dlqArn = (
    await raw.send(
      new GetQueueAttributesCommand({
        QueueUrl: `${PREFIX}${dlq}`,
        AttributeNames: ['QueueArn'],
      }),
    )
  ).Attributes!.QueueArn;
  await raw.send(
    new CreateQueueCommand({
      QueueName: queue,
      Attributes: {
        ...fifoAttrs,
        VisibilityTimeout: String(opts.visibility ?? 30),
        ...(opts.maxReceiveCount && {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: opts.maxReceiveCount,
          }),
        }),
      },
    }),
  );
  created.push(queue);
  return { queue, dlq };
}

async function readQueue(queue: string, wait = 1) {
  // One receive pass with visibility 0, so the messages stay on the queue and are not counted twice.
  const { Messages = [] } = await raw.send(
    new ReceiveMessageCommand({
      QueueUrl: `${PREFIX}${queue}`,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: wait,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  const seen = new Set<string>();
  return Messages.filter(
    (m) => !seen.has(m.MessageId!) && seen.add(m.MessageId!),
  ).map((m) => ({
    body: m.Body!,
    attributes: Object.fromEntries(
      Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [
        k,
        v.StringValue ?? '',
      ]),
    ),
  }));
}

afterAll(async () => {
  await Promise.allSettled(stops.map((s) => s()));
  await Promise.allSettled(
    created.map((q) =>
      raw.send(new DeleteQueueCommand({ QueueUrl: `${PREFIX}${q}` })),
    ),
  );
});

describe('S53 task queue (ElasticMQ)', () => {
  const sqs = new SqsTaskQueue(config as never);
  const consume = <T>(
    q: string,
    handler: (m: TaskMessage<T>) => Promise<void>,
    options: Parameters<TaskQueue['consume']>[2] = {},
  ) => {
    const stop = sqs.consume<T>(q, handler, { waitTimeSec: 1, ...options });
    stops.push(stop);
    return stop;
  };

  it('S53 AS-92: a 2 s delay hides the task, then delivers it once', async () => {
    const { queue } = await makeQueue('delay');
    const started = Date.now();
    const seen: number[] = [];
    consume<{ n: number }>(
      queue,
      async () => void seen.push(Date.now() - started),
    );
    await sqs.enqueue(queue, { n: 1 }, { delaySeconds: 2 });
    await sleep(1_000);
    expect(seen).toEqual([]);
    await until(() => seen.length > 0);
    await sleep(1_500);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(1_800);
  }, 30_000);

  it('S53 AS-92: invalid options reject before any request is made', async () => {
    const { queue } = await makeQueue('invalid');
    await expect(
      sqs.enqueue(queue, { n: 1 }, { delaySeconds: 901 }),
    ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
    expect(await readQueue(queue)).toEqual([]);
  });

  it('S53 AS-93: one of two messages with the same dedupeId is delivered', async () => {
    const { queue } = await makeQueue('dedupe', { fifo: true });
    const got: string[] = [];
    consume<{ id: string }>(queue, async (m) => void got.push(m.body.id));
    await sqs.enqueue(
      queue,
      { id: 'first' },
      { groupId: 'g', dedupeId: 'same' },
    );
    await sqs.enqueue(
      queue,
      { id: 'second' },
      { groupId: 'g', dedupeId: 'same' },
    );
    await until(() => got.length > 0);
    await sleep(1_500);
    expect(got).toEqual(['first']);
  }, 30_000);

  it('S53 AS-93: a group is delivered in order one at a time, and a failing message blocks only its group', async () => {
    const { queue } = await makeQueue('groups', { fifo: true, visibility: 2 });
    const order: string[] = [];
    const running = new Map<string, number>();
    let overlap = false;
    consume<{ group: string; n: number; fail?: boolean }>(
      queue,
      async ({ body }) => {
        const now = (running.get(body.group) ?? 0) + 1;
        running.set(body.group, now);
        if (now > 1) overlap = true;
        try {
          await sleep(100);
          if (body.fail) throw new Error('poison');
          order.push(`${body.group}${body.n}`);
        } finally {
          running.set(body.group, running.get(body.group)! - 1);
        }
      },
      { visibilityTimeoutSec: 2 },
    );
    const send = (group: string, n: number, fail = false) =>
      sqs.enqueue(
        queue,
        { group, n, fail },
        { groupId: group, dedupeId: `${group}${n}` },
      );
    // Group A: a1 always fails and holds a2 back. Group B: b1, b2, b3 flow.
    await send('A', 1, true);
    await send('A', 2);
    for (const n of [1, 2, 3]) await send('B', n);
    await until(() => order.filter((o) => o.startsWith('B')).length === 3);
    await sleep(3_000); // a1 has failed at least once more; a2 must still be held back
    expect(order.filter((o) => o.startsWith('B'))).toEqual(['B1', 'B2', 'B3']);
    expect(order.filter((o) => o.startsWith('A'))).toEqual([]);
    expect(overlap).toBe(false);
  }, 40_000);

  it('S53 AS-94: concurrency 4, 15 s handlers: never more than 4 in flight, each delivered once, visibility extended', async () => {
    const { queue } = await makeQueue('concurrency', {
      visibility: 6,
      maxReceiveCount: 5,
    });
    let inFlight = 0;
    let peak = 0;
    const started = new Map<number, number>();
    const done = new Set<number>();
    consume<{ n: number }>(
      queue,
      async ({ body, receiveCount }) => {
        started.set(body.n, (started.get(body.n) ?? 0) + 1);
        expect(receiveCount).toBe(1);
        peak = Math.max(peak, ++inFlight);
        try {
          await sleep(15_000);
          done.add(body.n);
        } finally {
          inFlight--;
        }
      },
      { concurrency: 4, visibilityTimeoutSec: 6 },
    );
    await sqs.enqueueBatch(
      queue,
      Array.from({ length: 20 }, (_, n) => ({ body: { n } })),
    );
    await until(() => done.size === 20, 110_000);
    expect(peak).toBeLessThanOrEqual(4);
    expect([...started.values()].every((c) => c === 1)).toBe(true);
    expect(await readQueue(queue)).toEqual([]);
  }, 130_000);

  it('S53 AS-95: a failing handler sees receiveCount 1, 2, 3, then the message is in the dead-letter queue', async () => {
    const { queue, dlq } = await makeQueue('redrive', {
      visibility: 1,
      maxReceiveCount: 3,
    });
    const counts: number[] = [];
    consume<{ n: number }>(
      queue,
      async ({ receiveCount }) => {
        counts.push(receiveCount);
        throw new Error('always');
      },
      { visibilityTimeoutSec: 1 },
    );
    await sqs.enqueue(queue, { n: 1 });
    await until(async () => (await readQueue(dlq)).length === 1, 30_000);
    expect(counts).toEqual([1, 2, 3]);
  }, 40_000);

  it('S53 AS-96: a body that fails the schema goes to the dead-letter queue at once and the handler is not called', async () => {
    const { queue, dlq } = await makeQueue('schema');
    const handler = jest.fn(async () => undefined);
    consume<{ n: number }>(queue, handler, {
      bodySchema: {
        safeParse: (v) => ({
          success: typeof (v as { n?: unknown })?.n === 'number',
        }),
      },
      deadLetterQueue: dlq,
    });
    await sqs.enqueue(queue, { n: 'not a number' });
    await until(async () => (await readQueue(dlq)).length === 1, 15_000);
    const [dead] = await readQueue(dlq);
    expect(dead.attributes.deadLetterReason).toBe('SCHEMA_INVALID');
    expect(dead.attributes.sourceQueue).toBe(queue);
    expect(handler).not.toHaveBeenCalled();
    expect(await readQueue(queue)).toEqual([]);
  }, 30_000);

  describe('duplicate delivery', () => {
    let app: INestApplication;
    beforeAll(async () => {
      const moduleRef = await generateTestingModule([InboxModule]);
      app = moduleRef.createNestApplication();
      await app.init();
    });
    afterAll(async () => app.close());

    it('S53 AS-97: the same message delivered twice with recordOnce has one effect', async () => {
      const { queue } = await makeQueue('duplicate');
      const inbox = app.get(InboxService);
      const runner = app.get(TransactionRunner);
      const consumer = `s53-as97-${RUN}`;
      const effects: string[] = [];
      let deliveries = 0;
      consume<{ eventId: string }>(queue, async ({ body }) => {
        deliveries++;
        await runner.run(async () => {
          if (await inbox.recordOnce(consumer, body.eventId))
            effects.push(body.eventId);
        });
      });
      const eventId = uuidv7();
      await sqs.enqueue(queue, { eventId });
      await sqs.enqueue(queue, { eventId });
      await until(() => deliveries === 2);
      await sleep(500);
      expect(effects).toEqual([eventId]);
    }, 30_000);
  });

  it('S53 AS-98: stop() resolves after the in-flight messages finish and makes no further receive call', async () => {
    const { queue } = await makeQueue('stop');
    const finished: number[] = [];
    let entered = 0;
    const stop = sqs.consume<{ n: number }>(
      queue,
      async ({ body }) => {
        entered++;
        await sleep(2_000);
        finished.push(body.n);
      },
      { concurrency: 2, waitTimeSec: 1 },
    );
    await sqs.enqueueBatch(queue, [{ body: { n: 1 } }, { body: { n: 2 } }]);
    await until(() => entered === 2);
    await sqs.enqueue(queue, { n: 3 }); // arrives while stopping; must not be received
    await stop();
    expect(finished.sort()).toEqual([1, 2]);
    const left = await readQueue(queue);
    expect(left.map((m) => JSON.parse(m.body).n)).toEqual([3]);
    expect(entered).toBe(2);
  }, 30_000);

  it('S53 AS-99: 25 tasks are delivered in chunks of 10; a rejected entry is reported by index and re-sending only it creates no duplicate', async () => {
    const { queue } = await makeQueue('batch', { fifo: true });
    const entry = (n: number, dedupe = true) => ({
      body: { n },
      options: { groupId: `g${n}`, ...(dedupe && { dedupeId: `d${n}` }) },
    });
    // A FIFO queue without content-based deduplication rejects an entry that has no dedupeId.
    const entries = Array.from({ length: 25 }, (_, n) => entry(n, n !== 7));
    const result = await sqs.enqueueBatch(queue, entries);
    expect(result.sent).toBe(24);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].index).toBe(7);
    expect(result.failed[0].reason).not.toBe('');

    const retry = await sqs.enqueueBatch(queue, [entry(7)]);
    expect(retry).toEqual({ sent: 1, failed: [] });

    const got: number[] = [];
    consume<{ n: number }>(queue, async ({ body }) => void got.push(body.n));
    await until(() => got.length >= 25);
    await sleep(1_000);
    expect(got.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, n) => n),
    );
  }, 40_000);

  it('S53 AS-100: an event forwarded twice to a queue with dedupeId = eventId:recipientId leaves one message per recipient', async () => {
    const { queue } = await makeQueue('bridge', { fifo: true });
    const event = {
      eventId: uuidv7(),
      payload: { recipients: ['r1', 'r2', 'r3'] },
    };
    const forward = async (e: typeof event) => {
      for (const recipientId of e.payload.recipients)
        await sqs.enqueue(
          queue,
          { eventId: e.eventId, recipientId },
          { groupId: recipientId, dedupeId: `${e.eventId}:${recipientId}` },
        );
    };
    await forward(event);
    await forward(event);
    const got: string[] = [];
    consume<{ recipientId: string }>(
      queue,
      async ({ body }) => void got.push(body.recipientId),
    );
    await until(() => got.length >= 3);
    await sleep(1_500);
    expect(got.sort()).toEqual(['r1', 'r2', 'r3']);
  }, 30_000);

  it('S53 AS-101: a task enqueued inside a span is handled under the same trace id', async () => {
    const tracing = installTestTracing();
    try {
      const { queue } = await makeQueue('trace');
      let handlerTrace: string | undefined;
      consume<{ n: number }>(queue, async () => {
        handlerTrace = trace.getSpan(context.active())?.spanContext().traceId;
      });
      const producer = tracing.tracer.startSpan('producer');
      await context.with(trace.setSpan(context.active(), producer), () =>
        sqs.enqueue(queue, { n: 1 }),
      );
      producer.end();
      await until(() => handlerTrace !== undefined);
      expect(handlerTrace).toBe(producer.spanContext().traceId);
    } finally {
      await tracing.shutdown();
    }
  }, 30_000);
});

describe('S53 task queue in-memory fake parity', () => {
  it('S53 AS-92: the fake rejects the same invalid options', async () => {
    const fake = new InMemoryTaskQueue();
    await expect(
      fake.enqueue('q', {}, { delaySeconds: 901 }),
    ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
    await expect(
      fake.enqueue('q.fifo', {}, { groupId: 'g', delaySeconds: 1 }),
    ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
  });

  it('S53 AS-99: the fake reports batch results in the same shape', async () => {
    const fake = new InMemoryTaskQueue();
    expect(await fake.enqueueBatch('q', [{ body: 1 }, { body: 2 }])).toEqual({
      sent: 2,
      failed: [],
    });
  });

  it('S53 AS-96: the fake dead-letters a body that fails the schema without calling the handler', async () => {
    const fake = new InMemoryTaskQueue();
    const handler = jest.fn(async () => undefined);
    fake.consume('q', handler, {
      bodySchema: { safeParse: (v) => ({ success: typeof v === 'number' }) },
    });
    await fake.enqueue('q', 'nope');
    await fake.enqueue('q', 7);
    await fake.drain('q');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fake.deadLettered).toEqual([
      { queue: 'q', body: 'nope', reason: 'SCHEMA_INVALID' },
    ]);
  });
});
