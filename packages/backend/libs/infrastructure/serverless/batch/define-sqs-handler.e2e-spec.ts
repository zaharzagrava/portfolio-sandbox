import { z } from 'zod';
import { defineSqsHandler } from './define-sqs-handler';
import {
  startRunner,
  type LambdaHandler,
  type RunnerHandle,
} from '../runner/runner';
import {
  captureTelemetry,
  EffectCounter,
  waitFor,
  type Capture,
} from '../testing';
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

describe('defineSqsHandler through a real queue and the runner (e2e)', () => {
  const sqs = testSqsClient();
  let queue: TestQueue;
  let handle: RunnerHandle | undefined;
  let capture: Capture;

  beforeEach(async () => {
    capture = captureTelemetry();
    queue = await createTestQueue(sqs, { maxReceive: 2 });
  });
  afterEach(async () => {
    await handle?.stop();
    await queue.cleanup();
    capture.restore();
  });

  it('S55 AS-06: an invalid payload is rejected with no side effect, the good message beside it is processed, and the logs hold no part of the body', async () => {
    const effects = new EffectCounter();
    const handler = defineSqsHandler({
      function: {
        name: 'fixture',
        queue: queue.name,
        fifo: false,
        maxReceiveCount: 2,
      },
      bodySchema: z.object({ documentId: z.string().uuid() }),
      handle: async (message) => effects.write(message.body.documentId),
    });
    const good = '8f0c1f0e-0b0a-4d5e-9a41-1c7b6a9d2e11';
    await send(sqs, queue, 'not json: access_token=SECRET-TOKEN-1');
    await send(sqs, queue, JSON.stringify({ documentId: 'jane@example.com' }));
    await send(sqs, queue, JSON.stringify({ documentId: good }));

    const { manifestPath } = writeManifest([
      entryFor('fixture', queue, { maxReceiveCount: 2 }),
    ]);
    handle = await startRunner({
      manifestPath,
      sqs,
      queueUrlPrefix: SQS_PREFIX,
      waitTimeSeconds: 1,
      maxConcurrency: 1,
      loadHandler: () => handler as unknown as LambdaHandler,
    });

    await waitFor(() => effects.count(good) === 1);
    // the two bad messages fail on every receive and end in the dead-letter queue
    const dead = await waitFor(
      async () => {
        const found = await peek(sqs, queue.dlqUrl);
        return found.length === 2 ? found : undefined;
      },
      { timeoutMs: 40_000 },
    );
    expect(dead.map((m) => m.Body).sort()).toEqual(
      [
        'not json: access_token=SECRET-TOKEN-1',
        JSON.stringify({ documentId: 'jane@example.com' }),
      ].sort(),
    );
    expect(effects.count()).toBe(1); // no effect row for the bad ones
    expect(await depth(sqs, queue.url)).toBe(0);

    const failures = capture.logs('record failed');
    expect(failures.length).toBeGreaterThanOrEqual(4); // two messages, two receives each
    for (const line of failures) {
      expect(line.messageId).toBeTruthy();
      expect(line.failureClass).toBe('permanent');
    }
    const all = capture.lines.join('');
    expect(all).not.toContain('SECRET-TOKEN-1');
    expect(all).not.toContain('jane@example.com');
  });
});
