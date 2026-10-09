import {
  ChangeMessageVisibilityCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { LAMBDAS, LambdaSpec } from '../../lambdas/src/lambdas.manifest';
import { HANDLERS } from '../../lambdas/src/handlers';
import type {
  SqsBatchResponse,
  SqsEvent,
} from '../../lambdas/src/shared/sqs-batch';

/**
 * Local stand-in for the Lambda service + SQS event source mapping (D19):
 * long-polls ElasticMQ per manifest entry, builds the exact SQS→Lambda event
 * shape, invokes the handler, deletes only the records not reported in
 * `batchItemFailures` (the rest reappear after the visibility timeout, like
 * in AWS), and extends visibility while a slow invocation runs.
 * Usage: pnpm start:lambda-local [name...]   (SQS_ENDPOINT defaults to local ElasticMQ)
 */
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
const prefix = process.env.SQS_QUEUE_URL_PREFIX ?? `${endpoint}/000000000000/`;
const sqs = new SQSClient({
  region: 'eu-central-1',
  endpoint,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
let running = true;

async function pump(spec: LambdaSpec) {
  const queueUrl = `${prefix}${spec.queue}`;
  const arn =
    (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      )
    ).Attributes?.QueueArn ?? `arn:aws:sqs:local:000000000000:${spec.queue}`;
  const load = HANDLERS[spec.name];
  if (!load) throw new Error(`no handler registered for ${spec.name}`);
  const { handler } = await load();
  console.log(`[lambda-local] ${spec.name} ← ${spec.queue}`);

  while (running) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: spec.batchSize,
        WaitTimeSeconds: 20,
        VisibilityTimeout: spec.timeoutSec * 6,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) continue;
    const event: SqsEvent = {
      Records: messages.map((m) => ({
        messageId: m.MessageId!,
        receiptHandle: m.ReceiptHandle!,
        body: m.Body ?? '',
        attributes: {
          ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
          MessageGroupId: m.Attributes?.MessageGroupId,
          SentTimestamp: m.Attributes?.SentTimestamp,
        },
        eventSourceARN: arn,
      })),
    };
    const heartbeat = setInterval(() => {
      for (const m of messages)
        void sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle!,
              VisibilityTimeout: spec.timeoutSec * 6,
            }),
          )
          .catch(() => undefined);
    }, spec.timeoutSec * 3_000);
    let failed = new Set(event.Records.map((r) => r.messageId));
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`${spec.name} timed out after ${spec.timeoutSec}s`),
            ),
          spec.timeoutSec * 1000,
        ),
      );
      const result = await Promise.race([handler(event), timeout]);
      failed = new Set(result.batchItemFailures.map((f) => f.itemIdentifier));
    } catch (error) {
      console.error(
        `[lambda-local] ${spec.name} invocation failed - whole batch will be redelivered:`,
        (error as Error).message,
      );
    } finally {
      clearInterval(heartbeat);
    }
    const done = event.Records.filter((r) => !failed.has(r.messageId));
    if (done.length)
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: done.map((r, i) => ({
            Id: String(i),
            ReceiptHandle: r.receiptHandle,
          })),
        }),
      );
  }
}

async function main() {
  const only = process.argv.slice(2);
  const specs = LAMBDAS.filter(
    (l) => only.length === 0 || only.includes(l.name),
  );
  process.on('SIGTERM', () => (running = false));
  process.on('SIGINT', () => (running = false));
  await Promise.all(
    specs.map((s) =>
      pump(s).catch((e) =>
        console.error(`[lambda-local] ${s.name} stopped:`, e),
      ),
    ),
  );
}

void main();
