import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { TransactionRunner } from '@app/infrastructure/context';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { SqsTaskQueue } from '@app/infrastructure/sqs/sqs-task-queue';
import {
  EnqueueOptions,
  TaskQueue,
} from '@app/infrastructure/sqs/task-queue.port';
import { OutboxService } from './outbox.service';
import { OutboxPublisherModule } from './outbox-publisher.module';
import { OutboxPublisherService } from './outbox-publisher.service';

const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:9424';
const PREFIX =
  process.env.SQS_QUEUE_URL_PREFIX ?? 'http://localhost:9424/000000000000/';
const runId = uuidv7().slice(-8);
const QUEUE = `s53-otask-${runId}.fifo`;

const raw = new SQSClient({
  region: 'eu-central-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

/** The real queue, recording what the relay asked for and failing on demand. */
class RecordingQueue extends TaskQueue {
  readonly inner = new SqsTaskQueue({
    get: (key: string) =>
      ({
        sqs_endpoint: ENDPOINT,
        sqs_queue_url_prefix: PREFIX,
        aws_region: 'eu-central-1',
      })[key],
  } as never);
  readonly calls: { queue: string; body: unknown; options?: EnqueueOptions }[] =
    [];
  failing = false;
  enqueue<T>(queue: string, body: T, options?: EnqueueOptions) {
    this.calls.push({ queue, body, options });
    if (this.failing) return Promise.reject(new Error('queue unavailable'));
    return this.inner.enqueue(queue, body, options);
  }
  enqueueBatch: TaskQueue['enqueueBatch'] = (q, b) =>
    this.inner.enqueueBatch(q, b);
  consume: TaskQueue['consume'] = (q, h, o) => this.inner.consume(q, h, o);
}

describe('Outbox task rows relayed to a queue', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let outbox: OutboxService;
  let relay: OutboxPublisherService;
  let runner: TransactionRunner;
  const queue = new RecordingQueue();

  const received = async () => {
    const { Messages = [] } = await raw.send(
      new ReceiveMessageCommand({
        QueueUrl: `${PREFIX}${QUEUE}`,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 0,
      }),
    );
    return [...new Set(Messages.map((m) => m.Body!))];
  };
  const taskRows = async (aggregateId: string) => {
    const [rows] = await sequelize.query(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = $1`,
      {
        bind: [aggregateId],
      },
    );
    return rows as {
      id: string;
      kind: string;
      status: string;
      payload: Record<string, unknown>;
      publishedAt: Date | null;
      topic: string;
      type: string;
    }[];
  };

  beforeAll(async () => {
    await raw.send(
      new CreateQueueCommand({
        QueueName: QUEUE,
        Attributes: { FifoQueue: 'true' },
      }),
    );
    const moduleRef = await generateTestingModule(
      [EventsModule, OutboxPublisherModule.register({ ticker: false })],
      { customize: (b) => b.overrideProvider(TaskQueue).useValue(queue) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    sequelize = app.get(Sequelize);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxPublisherService);
    runner = app.get(TransactionRunner);
  });

  afterAll(async () => {
    await sequelize.query(`DELETE FROM "Outbox" WHERE "topic" = $1`, {
      bind: [QUEUE],
    });
    await raw
      .send(new DeleteQueueCommand({ QueueUrl: `${PREFIX}${QUEUE}` }))
      .catch(() => undefined);
    await app.close();
  });

  beforeEach(() => {
    queue.calls.length = 0;
    queue.failing = false;
  });

  const task = (aggregateId: string) => ({
    queue: QUEUE,
    type: 'identity.password_reset_requested',
    aggregateId,
    body: { token: `secret-${aggregateId}` },
    groupId: aggregateId,
  });

  it('S53 AS-90: a committed task is sent to the queue with the row id as dedupe id; a rollback sends nothing', async () => {
    const committed = `ct-${runId}`;
    const rolledBack = `rb-${runId}`;
    await runner.run(() => outbox.appendTask(task(committed)));
    await expect(
      runner.run(async () => {
        await outbox.appendTask(task(rolledBack));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const [row] = await taskRows(committed);
    expect(row).toMatchObject({
      kind: 'task',
      status: 'pending',
      topic: QUEUE,
    });
    expect(await taskRows(rolledBack)).toHaveLength(0);

    await relay.drain();

    const sent = queue.calls.filter((c) =>
      (c.body as { token?: string }).token?.endsWith(committed),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe(QUEUE);
    expect(sent[0].options).toMatchObject({
      dedupeId: row.id,
      groupId: committed,
    });
    expect(await received()).toContain(
      JSON.stringify({ token: `secret-${committed}` }),
    );
    expect(
      queue.calls.some((c) =>
        (c.body as { token?: string }).token?.endsWith(rolledBack),
      ),
    ).toBe(false);
    expect((await taskRows(committed))[0].status).toBe('published');
  }, 30_000);

  it('S53 AS-91: the body is cleared once sent and kept while the send fails', async () => {
    const id = `sc-${runId}`;
    await runner.run(() => outbox.appendTask(task(id)));

    queue.failing = true;
    await relay.drain();
    let [row] = await taskRows(id);
    expect(row.status).toBe('pending');
    expect(JSON.stringify(row.payload)).toContain(`secret-${id}`);

    queue.failing = false;
    // Backoff pushes nextAttemptAt out; make the row due again.
    await sequelize.query(
      `UPDATE "Outbox" SET "nextAttemptAt" = now() - interval '1 second' WHERE "aggregateId" = $1`,
      {
        bind: [id],
      },
    );
    await relay.drain();
    [row] = await taskRows(id);
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
    expect(row.topic).toBe(QUEUE);
    expect(row.type).toBe('identity.password_reset_requested');
    expect(JSON.stringify(row.payload)).not.toContain('secret');
  }, 30_000);
});
