import { startRunner, type LambdaHandler, type RunnerHandle } from './runner';
import { defineSqsHandler } from '../batch/define-sqs-handler';
import { PermanentError } from '../errors';
import { captureTelemetry, deferred, waitFor, type Capture } from '../testing';
import {
  createTestQueue,
  depth,
  entryFor,
  peek,
  send,
  SQS_PREFIX,
  testSqsClient,
  writeManifest,
  type TestQueue,
} from '../testing/queues';

describe('FIFO queues through the runner (e2e, ElasticMQ)', () => {
  const sqs = testSqsClient();
  const queues: TestQueue[] = [];
  const handles: RunnerHandle[] = [];
  let capture: Capture;
  const queue = async (options?: Parameters<typeof createTestQueue>[1]) => {
    const q = await createTestQueue(sqs, { fifo: true, ...options });
    queues.push(q);
    return q;
  };
  const start = async (
    q: TestQueue,
    handler: LambdaHandler,
    overrides = {},
  ) => {
    const { manifestPath } = writeManifest([
      entryFor('fn', q, { batchSize: 1, ...overrides }),
    ]);
    const handle = await startRunner({
      manifestPath,
      sqs,
      queueUrlPrefix: SQS_PREFIX,
      waitTimeSeconds: 1,
      maxConcurrency: 2,
      loadHandler: () => handler,
    });
    handles.push(handle);
    return handle;
  };

  beforeEach(() => (capture = captureTelemetry()));
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.stop()));
    await Promise.all(queues.splice(0).map((q) => q.cleanup()));
    capture.restore();
  });

  it('S55 AS-31: a repeated dedupe ID is delivered once; a group is in send order with one batch in flight; groups run together', async () => {
    const q = await queue({ visibilitySec: 30 });
    await send(sqs, q, 'm1', { group: 'A', dedupeId: 'same' });
    await send(sqs, q, 'm1-again', { group: 'A', dedupeId: 'same' }); // inside the dedupe window: dropped
    await send(sqs, q, 'm2', { group: 'A' });
    await send(sqs, q, 'm3', { group: 'A' });
    await send(sqs, q, 'n1', { group: 'B' });
    const gate = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    await start(
      q,
      async (event) => {
        const body = event.Records[0].body;
        started.push(body);
        if (body === 'm1') await gate.promise; // A's first batch stays in flight
        finished.push(body);
        return { batchItemFailures: [] };
      },
      { timeoutSec: 5, visibilityTimeoutSec: 30 },
    );

    await waitFor(() => started.includes('n1') && started.includes('m1'));
    await new Promise((r) => setTimeout(r, 500));
    expect(started).not.toContain('m2'); // no second batch of group A while the first is in flight
    expect(started).not.toContain('m1-again');
    gate.resolve();
    await waitFor(() => finished.length === 4);
    expect(finished.filter((b) => b.startsWith('m'))).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(started).not.toContain('m1-again');
  });

  it('S55 AS-32: a poison message blocks only its group until its receive limit, then the group continues; the break is reported once', async () => {
    const q = await queue({ visibilitySec: 6, maxReceive: 3 });
    await send(sqs, q, JSON.stringify('a1'), { group: 'A' });
    await send(sqs, q, JSON.stringify('a2'), { group: 'A' });
    await send(sqs, q, JSON.stringify('b1'), { group: 'B' });
    const handled: string[] = [];
    const a1Receives: number[] = [];
    const handler = defineSqsHandler<string>({
      function: { name: 'fn', queue: q.name, fifo: true, maxReceiveCount: 3 },
      handle: async (message) => {
        if (message.body === 'a1') {
          a1Receives.push(message.receiveCount);
          throw new PermanentError('poison');
        }
        handled.push(message.body);
      },
    });
    await start(q, handler as unknown as LambdaHandler, { maxReceiveCount: 3 });

    await waitFor(() => handled.includes('b1'), { timeoutMs: 5_000 }).catch(
      (error) => {
        throw new Error(
          `${error.message}; handled=${handled}; log=${capture.lines.join('')}`,
        );
      },
    ); // b1 at once
    expect(handled).not.toContain('a2');
    await waitFor(() => handled.includes('a2'), { timeoutMs: 40_000 }); // after a1's third failed receive
    expect(a1Receives).toEqual([1, 2, 3]);
    const dead = await waitFor(
      async () => {
        const found = await peek(sqs, q.dlqUrl);
        return found.length ? found : undefined;
      },
      { timeoutMs: 10_000 },
    );
    expect(dead.map((m) => m.Body)).toEqual([JSON.stringify('a1')]);
    expect(capture.metrics('FifoGroupOrderBroken')).toHaveLength(1);
    expect(capture.metrics('DeadLettered')).toHaveLength(1);
    await waitFor(async () => (await depth(sqs, q.url)) === 0);
  });
});
