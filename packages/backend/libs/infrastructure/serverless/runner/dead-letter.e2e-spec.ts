import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { startRunner, type LambdaHandler, type RunnerHandle } from './runner';
import { redrive } from './redrive';
import { captureTelemetry, waitFor, type Capture } from '../testing';
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

describe('dead letters and redrive (e2e, ElasticMQ)', () => {
  const sqs = testSqsClient();
  const queues: TestQueue[] = [];
  const handles: RunnerHandle[] = [];
  let capture: Capture;
  const queue = async (options?: Parameters<typeof createTestQueue>[1]) => {
    const q = await createTestQueue(sqs, options);
    queues.push(q);
    return q;
  };
  const start = async (q: TestQueue, handler: LambdaHandler, name = 'fn') => {
    const { manifestPath } = writeManifest([entryFor(name, q)]);
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

  it('S55 AS-33: after the receive limit a failing message leaves the source queue and lands in the dead-letter queue unchanged, after exactly 3 invocations', async () => {
    const q = await queue({ maxReceive: 3 });
    await send(sqs, q, 'poison-body', {
      attributes: { tenant: 't-9', kind: 'doc' },
    });
    let invocations = 0;
    await start(q, async (event) => {
      invocations += event.Records.length;
      return {
        batchItemFailures: event.Records.map((r) => ({
          itemIdentifier: r.messageId,
        })),
      };
    });
    const dead = await waitFor(
      async () => {
        const found = await peek(sqs, q.dlqUrl);
        return found.length ? found : undefined;
      },
      { timeoutMs: 40_000 },
    );
    expect(dead).toHaveLength(1);
    expect(dead[0].Body).toBe('poison-body');
    expect(dead[0].MessageAttributes).toMatchObject({
      tenant: { StringValue: 't-9' },
      kind: { StringValue: 'doc' },
    });
    expect(invocations).toBe(3);
    expect(await depth(sqs, q.url)).toBe(0);
  });

  describe('S55 AS-36: redrive', () => {
    it('moves every message of a standard dead-letter queue back with body and attributes, prints the count, and the function processes them', async () => {
      const q = await queue();
      for (const body of ['one', 'two', 'three'])
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: q.dlqUrl,
            MessageBody: body,
            MessageAttributes: {
              tenant: { DataType: 'String', StringValue: 't-1' },
            },
          }),
        );
      const moved = await redrive({ dlq: q.dlqName, sqs });
      expect(moved).toBe(3);
      expect(await depth(sqs, q.dlqUrl)).toBe(0);
      const seen: { body: string; tenant?: string }[] = [];
      await start(q, async (event) => {
        seen.push(
          ...event.Records.map((r) => ({
            body: r.body,
            tenant: r.messageAttributes?.tenant?.stringValue,
          })),
        );
        return { batchItemFailures: [] };
      });
      await waitFor(() => seen.length === 3);
      expect(seen.map((s) => s.body).sort()).toEqual(['one', 'three', 'two']);
      expect(seen.every((s) => s.tenant === 't-1')).toBe(true);
    });

    it('keeps the group ID of FIFO messages and gives each a fresh dedupe ID', async () => {
      const q = await queue({ fifo: true });
      const originals = ['x1', 'x2', 'x3'].map(
        (b, i) => `dedupe-original-${i}-${b}`,
      );
      for (const [i, body] of ['x1', 'x2', 'x3'].entries())
        await send(sqs, { url: q.dlqUrl, fifo: true }, body, {
          group: 'G-fifo',
          dedupeId: originals[i],
        });
      const moved = await redrive({ dlq: q.dlqName, sqs });
      expect(moved).toBe(3);
      expect(await depth(sqs, q.dlqUrl)).toBe(0);
      const seen: { body: string; group?: string; dedupe?: string }[] = [];
      await start(q, async (event) => {
        seen.push(
          ...event.Records.map((r) => ({
            body: r.body,
            group: r.attributes.MessageGroupId,
            dedupe: r.attributes.MessageDeduplicationId,
          })),
        );
        return { batchItemFailures: [] };
      });
      await waitFor(() => seen.length === 3);
      expect(seen.map((s) => s.body)).toEqual(['x1', 'x2', 'x3']);
      expect(seen.every((s) => s.group === 'G-fifo')).toBe(true);
      for (const s of seen) expect(originals).not.toContain(s.dedupe);
    });

    it('moves 0 from an empty dead-letter queue and does not fail', async () => {
      const q = await queue();
      await expect(redrive({ dlq: q.dlqName, sqs })).resolves.toBe(0);
    });
  });
});
