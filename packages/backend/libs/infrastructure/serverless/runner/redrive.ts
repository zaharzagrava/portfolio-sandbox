import { randomUUID } from 'node:crypto';
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  type Message,
  type MessageAttributeValue,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { log } from '../telemetry/telemetry';

export interface RedriveOptions {
  /** Name of the dead-letter queue, e.g. `onboarding-documents-dlq` or `webhook-deliveries-dlq.fifo`. */
  dlq: string;
  /** Name of the queue the messages go back to; defaults to the dead-letter queue's name without `-dlq`. */
  source?: string;
  sqs: Pick<SQSClient, 'send'>;
}

export const sourceQueueOf = (dlq: string): string =>
  dlq.replace(/-dlq(\.fifo)?$/, (_m, fifo) => fifo ?? '');

/**
 * Local redrive (S55 FR-046): moves every message of a dead-letter queue back to its source queue with the body, the
 * group ID and the message attributes unchanged, and a fresh dedupe ID for FIFO (the original one may still be inside
 * the 5-minute window). Returns the count moved; an empty queue moves 0 (and the caller exits 0).
 */
export async function redrive({
  dlq,
  source,
  sqs,
}: RedriveOptions): Promise<number> {
  const target = source ?? sourceQueueOf(dlq);
  if (target === dlq)
    throw new Error(`"${dlq}" is not a dead-letter queue name`);
  const dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: dlq })))
    .QueueUrl!;
  const sourceUrl = (
    await sqs.send(new GetQueueUrlCommand({ QueueName: target }))
  ).QueueUrl!;
  const fifo = target.endsWith('.fifo');
  let moved = 0;
  for (;;) {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages: Message[] = received.Messages ?? [];
    if (messages.length === 0) break;
    const sent = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: sourceUrl,
        Entries: messages.map((m, i) => ({
          Id: String(i),
          MessageBody: m.Body ?? '',
          MessageAttributes: m.MessageAttributes as
            Record<string, MessageAttributeValue> | undefined,
          ...(fifo && {
            MessageGroupId: m.Attributes?.MessageGroupId ?? 'default',
            MessageDeduplicationId: randomUUID(),
          }),
        })),
      }),
    );
    const failed = new Set((sent.Failed ?? []).map((f) => f.Id));
    for (const f of sent.Failed ?? [])
      log('error', 'redrive: message could not be sent back', {
        code: f.Code,
        id: f.Id,
      });
    const done = messages.filter((_m, i) => !failed.has(String(i)));
    if (done.length) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: dlqUrl,
          Entries: done.map((m, i) => ({
            Id: String(i),
            ReceiptHandle: m.ReceiptHandle!,
          })),
        }),
      );
      moved += done.length;
    }
    if (failed.size === messages.length) break; // nothing moved this round: stop instead of looping on the same messages
  }
  return moved;
}
