import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { ManifestEntry } from '../manifest/lambda-spec';
import { shardName } from '@app/common/shard';

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:9424';
export const SQS_PREFIX =
  process.env.SQS_QUEUE_URL_PREFIX ?? 'http://localhost:9424/000000000000/';

export const testSqsClient = () =>
  new SQSClient({
    region: 'eu-central-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

export interface TestQueue {
  name: string;
  url: string;
  dlqName: string;
  dlqUrl: string;
  fifo: boolean;
  cleanup(): Promise<void>;
}

/** A queue pair with unique names, so a test never depends on what another test left (L-006). */
export async function createTestQueue(
  sqs: SQSClient,
  options: { fifo?: boolean; visibilitySec?: number; maxReceive?: number } = {},
): Promise<TestQueue> {
  const fifo = options.fifo ?? false;
  const base = `s55-${randomUUID().slice(0, 8)}`;
  const name = fifo ? `${base}.fifo` : base;
  const dlqName = fifo ? `${base}-dlq.fifo` : `${base}-dlq`;
  const fifoAttributes = fifo
    ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' }
    : {};
  const dlqUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: shardName(dlqName),
        Attributes: { ...fifoAttributes },
      }),
    )
  ).QueueUrl!;
  const url = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: shardName(name),
        Attributes: {
          ...fifoAttributes,
          VisibilityTimeout: String(options.visibilitySec ?? 6),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: `arn:aws:sqs:elasticmq:000000000000:${shardName(dlqName)}`,
            maxReceiveCount: options.maxReceive ?? 3,
          }),
        },
      }),
    )
  ).QueueUrl!;
  return {
    name,
    url,
    dlqName,
    dlqUrl,
    fifo,
    cleanup: async () => {
      await sqs
        .send(new DeleteQueueCommand({ QueueUrl: url }))
        .catch(() => undefined);
      await sqs
        .send(new DeleteQueueCommand({ QueueUrl: dlqUrl }))
        .catch(() => undefined);
    },
  };
}

export async function send(
  sqs: SQSClient,
  queue: Pick<TestQueue, 'url' | 'fifo'>,
  body: string,
  options: {
    group?: string;
    dedupeId?: string;
    attributes?: Record<string, string>;
  } = {},
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queue.url,
      MessageBody: body,
      MessageAttributes: Object.fromEntries(
        Object.entries(options.attributes ?? {}).map(([k, v]) => [
          k,
          { DataType: 'String', StringValue: v },
        ]),
      ),
      ...(queue.fifo && {
        MessageGroupId: options.group ?? 'g',
        MessageDeduplicationId: options.dedupeId ?? randomUUID(),
      }),
    }),
  );
}

/** Messages visible right now, received without hiding them for long (and not counted as the test's own receives). */
export async function peek(sqs: SQSClient, url: string): Promise<Message[]> {
  return (
    (
      await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 0,
          MessageSystemAttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
      )
    ).Messages ?? []
  );
}

export async function depth(sqs: SQSClient, url: string): Promise<number> {
  const a = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    )
  ).Attributes!;
  return (
    Number(a.ApproximateNumberOfMessages) +
    Number(a.ApproximateNumberOfMessagesNotVisible)
  );
}

export { PurgeQueueCommand };

/** A `dist/lambda-bundles`-shaped folder with a `manifest.json` (and no bundles unless the test adds them). */
export function writeManifest(entries: ManifestEntry[]): {
  dir: string;
  manifestPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 's55-runner-'));
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
  return { dir, manifestPath };
}

/** A manifest entry for a test queue with sensible small numbers. */
export function entryFor(
  name: string,
  queue: Pick<TestQueue, 'name' | 'fifo'>,
  overrides: Partial<ManifestEntry> = {},
): ManifestEntry {
  const timeoutSec = overrides.timeoutSec ?? 1;
  return {
    name,
    entry: `handlers/${name}.js`,
    queue: queue.name,
    fifo: queue.fifo,
    timeoutSec,
    memoryMb: 128,
    batchSize: 5,
    maxConcurrency: 2,
    visibilityTimeoutSec: 6 * timeoutSec,
    maxReceiveCount: 3,
    dbPoolMax: 2,
    ...overrides,
  };
}
