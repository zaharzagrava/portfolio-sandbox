import { v7 as uuidv7 } from 'uuid';
import { Environment } from '@app/common/types';
import {
  createTopics,
  deleteTopicsMatching,
  testKafka,
} from '@app/test/utils/kafka-test';
import {
  TransactionalPipeline,
  type PipelineHandle,
} from './transactional-pipeline';

const runId = uuidv7().slice(-8);
const config = {
  get: (key: string) =>
    ({
      node_env: Environment.test,
      kafka_broker: process.env.KAFKA_BROKER ?? 'localhost:9192',
    })[key],
};
const pipeline = new TransactionalPipeline(config as never);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

/** What a `read_committed` reader sees on `topic` after `settleMs` of quiet. */
async function readCommitted(
  topic: string,
  settleMs = 2_500,
): Promise<string[]> {
  const consumer = testKafka().consumer({
    groupId: `rc-${uuidv7()}`,
    readUncommitted: false,
  });
  const seen: string[] = [];
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) =>
      void seen.push(message.value!.toString()),
  });
  await sleep(settleMs);
  await consumer.disconnect();
  return seen;
}

async function committedOffset(group: string, topic: string): Promise<number> {
  const admin = testKafka().admin();
  await admin.connect();
  try {
    const [p] = await admin.fetchOffsets({ groupId: group, topics: [topic] });
    return Number(p.partitions[0].offset);
  } finally {
    await admin.disconnect();
  }
}

async function produce(topic: string, values: string[]) {
  const producer = testKafka().producer();
  await producer.connect();
  await producer.send({ topic, messages: values.map((value) => ({ value })) });
  await producer.disconnect();
}

describe('Kafka transactional consume-transform-produce pipeline', () => {
  const handles: PipelineHandle[] = [];
  afterAll(async () => {
    await Promise.allSettled(handles.map((h) => h.stop()));
    await deleteTopicsMatching(new RegExp(runId));
  });

  const topics = async (name: string) => {
    const input = `s53-${name}-${runId}-in`;
    const output = `s53-${name}-${runId}-out`;
    await createTopics([{ topic: input }, { topic: output }]);
    return { input, output };
  };
  const start = async (...args: Parameters<TransactionalPipeline['run']>) => {
    const handle = await pipeline.run(...args);
    handles.push(handle);
    return handle;
  };

  it('S53 AS-102: 10 inputs and 3 outputs are committed together: the reader sees 3 outputs once, the group offset moved by 10', async () => {
    const { input, output } = await topics('commit');
    await produce(
      input,
      Array.from({ length: 10 }, (_, i) => `in-${i}`),
    );
    let handled = 0;
    await start({
      transactionalId: `tx-commit-${runId}`,
      groupId: `g-commit-${runId}`,
      inputTopic: input,
      handle: async (batch, emit) => {
        handled += batch.messages.length;
        if (handled === 10)
          await emit(
            output,
            ['out-a', 'out-b', 'out-c'].map((value) => ({ value })),
          );
      },
    });
    await until(() => handled === 10);
    await until(
      async () => (await committedOffset(`g-commit-${runId}`, input)) === 10,
    );
    expect((await readCommitted(output)).sort()).toEqual([
      'out-a',
      'out-b',
      'out-c',
    ]);
  }, 60_000);

  it('S53 AS-103: outputs sent before a crash are invisible; after the restart the inputs are redelivered and the outputs appear once', async () => {
    const { input, output } = await topics('abort');
    await produce(input, ['x1', 'x2', 'x3']);
    let crashes = 0;
    const crashing = await start({
      transactionalId: `tx-abort-${runId}`,
      groupId: `g-abort-${runId}`,
      inputTopic: input,
      handle: async (batch, emit) => {
        await emit(
          output,
          batch.messages.map((m) => ({ value: `out-${m.value}` })),
        );
        crashes++;
        throw new Error('crash after send, before commit');
      },
    });
    await until(() => crashes >= 1);
    await crashing.stop();
    expect(await readCommitted(output)).toEqual([]);
    expect(
      await committedOffset(`g-abort-${runId}`, input),
    ).toBeLessThanOrEqual(0);

    let done = 0;
    await start({
      transactionalId: `tx-abort-${runId}`,
      groupId: `g-abort-${runId}`,
      inputTopic: input,
      handle: async (batch, emit) => {
        await emit(
          output,
          batch.messages.map((m) => ({ value: `out-${m.value}` })),
        );
        done += batch.messages.length;
      },
    });
    await until(() => done === 3);
    await until(
      async () => (await committedOffset(`g-abort-${runId}`, input)) === 3,
    );
    expect((await readCommitted(output)).sort()).toEqual([
      'out-x1',
      'out-x2',
      'out-x3',
    ]);
  }, 60_000);

  it('S53 AS-104: a second instance with the same transactional identity fences the first: its commit is rejected, it stops, no duplicates', async () => {
    const { input, output } = await topics('fence');
    await produce(input, ['y1', 'y2']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let olderEmitted = false;
    const older = await start({
      transactionalId: `tx-fence-${runId}`,
      groupId: `g-fence-older-${runId}`,
      inputTopic: input,
      handle: async (batch, emit) => {
        await emit(
          output,
          batch.messages.map((m) => ({ value: `older-${m.value}` })),
        );
        olderEmitted = true;
        await gate;
      },
    });
    await until(() => olderEmitted);

    let newerDone = 0;
    await start({
      transactionalId: `tx-fence-${runId}`,
      groupId: `g-fence-newer-${runId}`,
      inputTopic: input,
      handle: async (batch, emit) => {
        await emit(
          output,
          batch.messages.map((m) => ({ value: `newer-${m.value}` })),
        );
        newerDone += batch.messages.length;
      },
    });
    await until(() => newerDone === 2);
    await until(
      async () =>
        (await committedOffset(`g-fence-newer-${runId}`, input)) === 2,
    );

    release();
    await until(() => older.fenced);
    expect(
      await committedOffset(`g-fence-older-${runId}`, input),
    ).toBeLessThanOrEqual(0);
    expect((await readCommitted(output)).sort()).toEqual([
      'newer-y1',
      'newer-y2',
    ]);
  }, 90_000);
});
