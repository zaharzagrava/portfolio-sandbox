import { context, propagation, trace } from '@opentelemetry/api';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  startRunner,
  RunnerStartupError,
  type LambdaHandler,
  type RunnerClock,
  type RunnerHandle,
} from './runner';
import type { ManifestEntry } from '../manifest/lambda-spec';
import { defineSqsHandler } from '../batch/define-sqs-handler';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { log } from '../telemetry/telemetry';
import { captureTelemetry, deferred, waitFor, type Capture } from '../testing';
import {
  createTestQueue,
  depth,
  entryFor,
  send,
  SQS_PREFIX,
  testSqsClient,
  writeManifest,
  type TestQueue,
} from '../testing/queues';

/** The runner against a real queue service (ElasticMQ): the Lambda service's behaviour, observed from the queue. */
describe('local runner (e2e, ElasticMQ)', () => {
  const raw = testSqsClient();
  const queues: TestQueue[] = [];
  const handles: RunnerHandle[] = [];
  let capture: Capture;

  /** An SQS client whose commands a test can observe and, at the network edge, fail or rewrite. */
  function edge(rewrite?: (command: any) => Promise<any> | undefined) {
    const sent: any[] = [];
    const client = {
      send: (command: any, ...rest: any[]) => {
        sent.push(command);
        return rewrite?.(command) ?? (raw.send as any)(command, ...rest);
      },
    } as unknown as SQSClient;
    return { client, sent };
  }
  const queue = async (options?: Parameters<typeof createTestQueue>[1]) => {
    const q = await createTestQueue(raw, { maxReceive: 5, ...options });
    queues.push(q);
    return q;
  };
  async function run(
    entries: ManifestEntry[],
    handlers: Record<string, LambdaHandler>,
    sqs: SQSClient = raw,
    extra: Partial<Parameters<typeof startRunner>[0]> = {},
  ) {
    const { manifestPath } = writeManifest(entries);
    const handle = await startRunner({
      manifestPath,
      sqs,
      queueUrlPrefix: SQS_PREFIX,
      waitTimeSeconds: 1,
      maxConcurrency: 2,
      loadHandler: (entry) => handlers[entry.name],
      ...extra,
    });
    handles.push(handle);
    return handle;
  }
  const ok: LambdaHandler = async () => ({ batchItemFailures: [] });

  beforeEach(() => (capture = captureTelemetry()));
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.stop()));
    await Promise.all(queues.splice(0).map((q) => q.cleanup()));
    capture.restore();
  });

  it('S55 AS-38: each record has the full Lambda shape, for standard and FIFO queues, with attributes and in receive order', async () => {
    const std = await queue();
    const fifo = await queue({ fifo: true });
    await send(raw, std, 'first', {
      attributes: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tenant: 't1',
      },
    });
    await send(raw, std, 'second');
    await send(raw, fifo, 'fifo-body', {
      group: 'G1',
      dedupeId: 'D1',
      attributes: { tenant: 't1' },
    });
    const seen: Record<string, any[]> = { std: [], fifo: [] };
    await run([entryFor('std-fn', std), entryFor('fifo-fn', fifo)], {
      'std-fn': async (event) => (
        seen.std.push(...event.Records),
        { batchItemFailures: [] }
      ),
      'fifo-fn': async (event) => (
        seen.fifo.push(...event.Records),
        { batchItemFailures: [] }
      ),
    });
    await waitFor(() => seen.std.length === 2 && seen.fifo.length === 1);
    expect(seen.std.map((r) => r.body)).toEqual(['first', 'second']);
    const first = seen.std[0];
    expect(first).toMatchObject({
      eventSource: 'aws:sqs',
      awsRegion: 'eu-central-1',
      attributes: { ApproximateReceiveCount: '1' },
      messageAttributes: {
        traceparent: {
          stringValue:
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          dataType: 'String',
        },
        tenant: { stringValue: 't1', dataType: 'String' },
      },
    });
    expect(first.eventSourceARN.endsWith(std.name)).toBe(true);
    expect(first.md5OfBody).toMatch(/^[0-9a-f]{32}$/);
    expect(first.messageId).toBeTruthy();
    expect(first.receiptHandle).toBeTruthy();
    for (const key of [
      'SentTimestamp',
      'SenderId',
      'ApproximateFirstReceiveTimestamp',
    ])
      expect(first.attributes[key]).toBeTruthy();
    const record = seen.fifo[0];
    expect(record.eventSourceARN.endsWith('.fifo')).toBe(true);
    expect(record.attributes).toMatchObject({
      MessageGroupId: 'G1',
      MessageDeduplicationId: 'D1',
    });
    expect(record.attributes.SequenceNumber).toBeTruthy();
  });

  it('S55 AS-39: only the succeeded records are deleted; the failed one returns with receive count 2 and visibility is never extended', async () => {
    const q = await queue();
    for (const body of ['a', 'b', 'c']) await send(raw, q, body);
    const { client, sent } = edge();
    const seen: { body: string; count: string }[] = [];
    await run(
      [entryFor('fn', q)],
      {
        fn: async (event) => {
          for (const r of event.Records)
            seen.push({
              body: r.body,
              count: r.attributes.ApproximateReceiveCount,
            });
          const failing = event.Records.filter(
            (r) =>
              r.body === 'b' && r.attributes.ApproximateReceiveCount === '1',
          );
          return {
            batchItemFailures: failing.map((r) => ({
              itemIdentifier: r.messageId,
            })),
          };
        },
      },
      client,
    );
    await waitFor(() => seen.some((s) => s.body === 'b' && s.count === '2'), {
      timeoutMs: 20_000,
    });
    expect(seen.filter((s) => s.body === 'a')).toHaveLength(1);
    expect(seen.filter((s) => s.body === 'c')).toHaveLength(1);
    await waitFor(async () => (await depth(raw, q.url)) === 0);
    expect(sent.some((c) => c instanceof ChangeMessageVisibilityCommand)).toBe(
      false,
    );
    expect(
      sent.some(
        (c) =>
          c instanceof ReceiveMessageCommand &&
          c.input.VisibilityTimeout !== undefined,
      ),
    ).toBe(false);
  });

  it.each([
    [
      'throws',
      async () => {
        throw new Error('function exploded');
      },
      /function exploded/,
    ],
    [
      'never returns',
      () => new Promise<never>(() => undefined),
      /timed out after 1s/,
    ],
  ])(
    'S55 AS-40: a function that %s deletes nothing, the batch returns after the visibility timeout and is logged',
    async (_name, first, logged) => {
      const q = await queue();
      for (const body of ['a', 'b', 'c']) await send(raw, q, body);
      const counts: string[] = [];
      let calls = 0;
      await run([entryFor('fn', q)], {
        fn: async (event) => {
          calls++;
          if (calls === 1) return (first as () => Promise<never>)();
          counts.push(
            ...event.Records.map((r) => r.attributes.ApproximateReceiveCount),
          );
          return { batchItemFailures: [] };
        },
      });
      await waitFor(() => counts.length === 3, { timeoutMs: 25_000 });
      expect(counts).toEqual(['2', '2', '2']);
      expect(
        capture
          .logs()
          .some((l) => logged.test(String(l.message) + String(l.error))),
      ).toBe(true);
      if (_name === 'never returns')
        expect(capture.logs('abandoned_invocation')).toHaveLength(1);
    },
  );

  it('S55 AS-41: batches of at most 5, at most 2 invocations at once (the smaller of manifest and cap), every message once', async () => {
    const q = await queue();
    const bodies = Array.from({ length: 20 }, (_, i) => `m${i}`);
    for (const body of bodies) await send(raw, q, body);
    let inFlight = 0;
    let maxInFlight = 0;
    let maxBatch = 0;
    const processed: string[] = [];
    await run(
      [entryFor('fn', q, { maxConcurrency: 10 })],
      {
        fn: async (event) => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          maxBatch = Math.max(maxBatch, event.Records.length);
          await new Promise((r) => setTimeout(r, 150));
          processed.push(...event.Records.map((r) => r.body));
          inFlight--;
          return { batchItemFailures: [] };
        },
      },
      raw,
      { maxConcurrency: 2 },
    );
    await waitFor(() => processed.length === 20);
    expect(maxBatch).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBe(2);
    expect([...processed].sort()).toEqual([...bodies].sort());
  });

  describe('S55 AS-42: start-up failures exit before any receive', () => {
    const receives = (sent: any[]) =>
      sent.filter((c) => c instanceof ReceiveMessageCommand);

    it.each([
      [
        'visibility below 6 × the function timeout',
        async () => {
          const q = await queue({ visibilitySec: 6 });
          return {
            entries: [
              entryFor('slow-fn', q, {
                timeoutSec: 2,
                visibilityTimeoutSec: 12,
              }),
            ],
            only: undefined,
            reason:
              /slow-fn.*visibility 6 s is below 6 × the function timeout \(12 s\)/,
          };
        },
      ],
      [
        'a queue that does not exist',
        async () => {
          const q = await queue();
          return {
            entries: [entryFor('lost-fn', { ...q, name: 'no-such-queue-s55' })],
            only: undefined,
            reason: /lost-fn.*no-such-queue-s55 is not available/,
          };
        },
      ],
      [
        'a name that is not in the manifest',
        async () => {
          const q = await queue();
          return {
            entries: [entryFor('real-fn', q)],
            only: ['ghost-fn'],
            reason: /ghost-fn: not in the manifest/,
          };
        },
      ],
    ])('%s', async (_name, scenario) => {
      const { entries, only, reason } = await scenario();
      const { client, sent } = edge();
      const { manifestPath } = writeManifest(entries);
      const started = startRunner({
        manifestPath,
        sqs: client,
        queueUrlPrefix: SQS_PREFIX,
        only,
        loadHandler: () => ok,
      });
      await expect(started).rejects.toBeInstanceOf(RunnerStartupError);
      await expect(started).rejects.toThrow(reason);
      expect(receives(sent)).toHaveLength(0);
    });

    it('a manifest entry without a bundle', async () => {
      const q = await queue();
      const { client, sent } = edge();
      const { manifestPath } = writeManifest([entryFor('bundleless-fn', q)]);
      const started = startRunner({
        manifestPath,
        sqs: client,
        queueUrlPrefix: SQS_PREFIX,
      }); // default loader: requires the bundle
      await expect(started).rejects.toThrow(
        /bundleless-fn: no bundle at .*bundleless-fn\/index\.js/,
      );
      expect(receives(sent)).toHaveLength(0);
    });

    it('an invalid manifest', async () => {
      const q = await queue();
      const { client, sent } = edge();
      const { manifestPath } = writeManifest([
        entryFor('bad-fn', q, { maxConcurrency: 1 }),
      ]);
      await expect(
        startRunner({
          manifestPath,
          sqs: client,
          queueUrlPrefix: SQS_PREFIX,
          loadHandler: () => ok,
        }),
      ).rejects.toThrow(/bad-fn\.maxConcurrency/);
      expect(receives(sent)).toHaveLength(0);
    });
  });

  it('S55 AS-43: on stop it receives nothing more, lets the invocation finish and deletes what succeeded', async () => {
    const q = await queue({ visibilitySec: 180 });
    await send(raw, q, 'in-flight');
    const { client, sent } = edge();
    const started = deferred();
    const release = deferred();
    const handle = await run(
      [entryFor('fn', q, { timeoutSec: 30, visibilityTimeoutSec: 180 })],
      {
        fn: async () => {
          started.resolve();
          await release.promise;
          return { batchItemFailures: [] };
        },
      },
      client,
    );
    await started.promise;
    const receivesBeforeStop = sent.filter(
      (c) => c instanceof ReceiveMessageCommand,
    ).length;
    const stopping = handle.stop();
    release.resolve();
    await stopping;
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.filter((c) => c instanceof ReceiveMessageCommand).length).toBe(
      receivesBeforeStop,
    );
    expect(sent.some((c) => c instanceof DeleteMessageBatchCommand)).toBe(true);
    expect(await depth(raw, q.url)).toBe(0);
  });

  it('S55 AS-44: a delete that reports failed entries is logged with message id and code and the message comes back', async () => {
    const q = await queue();
    await send(raw, q, 'sticky');
    let failedOnce = false;
    const { client } = edge((command) => {
      if (command instanceof DeleteMessageBatchCommand && !failedOnce) {
        failedOnce = true;
        return Promise.resolve({
          Successful: [],
          Failed: [
            { Id: '0', Code: 'ReceiptHandleIsInvalid', SenderFault: true },
          ],
        });
      }
      return undefined;
    });
    const counts: string[] = [];
    await run(
      [entryFor('fn', q)],
      {
        fn: async (event) => (
          counts.push(
            ...event.Records.map((r) => r.attributes.ApproximateReceiveCount),
          ),
          { batchItemFailures: [] }
        ),
      },
      client,
    );
    await waitFor(() => counts.length === 2, { timeoutMs: 25_000 });
    expect(counts).toEqual(['1', '2']);
    const line = capture.logs(
      'lambda-local delete failed; the message will be redelivered',
    )[0];
    expect(line).toMatchObject({
      code: 'ReceiptHandleIsInvalid',
      function: 'fn',
    });
    expect(line.messageId).toBeTruthy();
    await waitFor(async () => (await depth(raw, q.url)) === 0);
  });

  it('S55 AS-45: a broker outage backs off 1 s doubling to 30 s, keeps the process alive and resumes without a restart', async () => {
    const q = await queue();
    let down = true;
    const { client } = edge((command) =>
      down && command instanceof ReceiveMessageCommand
        ? Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED'), {
              name: 'TimeoutError',
              code: 'ECONNREFUSED',
            }),
          )
        : undefined,
    );
    const delays: number[] = [];
    const clock: RunnerClock = {
      now: () => Date.now(),
      sleep: (ms) => (delays.push(ms), new Promise((r) => setImmediate(r))),
    };
    const processed: string[] = [];
    const handle = await run(
      [entryFor('fn', q)],
      {
        fn: async (event) => (
          processed.push(...event.Records.map((r) => r.body)),
          { batchItemFailures: [] }
        ),
      },
      client,
      { clock, maxConcurrency: 1 },
    ); // one poller, so the delays are one sequence
    try {
      await waitFor(() => delays.filter((d) => d === 30_000).length >= 2);
      expect(delays.slice(0, 7)).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]);
      expect(
        capture.logs('lambda-local receive failed; backing off').length,
      ).toBeGreaterThanOrEqual(7);
    } finally {
      down = false; // the broker is restored whatever happens (L-013)
    }
    await send(raw, q, 'after-outage');
    await waitFor(() => processed.includes('after-outage'));
    expect(handle).toBeDefined();
  });

  it('S55 AS-50: the producer trace continues in the function span and in every log line of the invocation', async () => {
    const tracing = installTestTracing();
    try {
      const q = await queue();
      const producerSpan = tracing.tracer.startSpan('producer');
      const carrier: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), producerSpan), () =>
        propagation.inject(context.active(), carrier),
      );
      producerSpan.end();
      const producer = producerSpan.spanContext();
      expect(carrier.traceparent).toContain(producer.traceId);
      await send(raw, q, JSON.stringify({ n: 1 }), {
        attributes: { traceparent: carrier.traceparent },
      });

      const handled = deferred<string>();
      const handler = defineSqsHandler({
        function: {
          name: 'fn',
          queue: q.name,
          fifo: false,
          maxReceiveCount: 5,
        },
        handle: async (message) => {
          log('info', 'inside the function', { n: 1 });
          handled.resolve(message.id);
        },
      });
      await run([entryFor('fn', q)], { fn: handler });
      const messageId = await Promise.race([
        handled.promise,
        new Promise<never>((_r, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `function not invoked; log: ${capture.lines.join('')}`,
                ),
              ),
            15_000,
          ),
        ),
      ]);
      await waitFor(() =>
        tracing.exporter
          .getFinishedSpans()
          .some((s) => s.name === 'fn process'),
      );
      const span = tracing.exporter
        .getFinishedSpans()
        .find((s) => s.name === 'fn process')!;
      expect(span.spanContext().traceId).toBe(producer.traceId);
      expect(span.parentSpanContext?.spanId).toBe(producer.spanId);
      const inside = capture.logs('inside the function')[0];
      expect(inside).toMatchObject({ traceId: producer.traceId, messageId });
    } finally {
      await tracing.shutdown();
    }
  });
});
