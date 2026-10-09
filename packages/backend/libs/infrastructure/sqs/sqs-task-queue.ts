import { Injectable, Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { context, propagation } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { validateEnqueueOptions } from './enqueue-options';
import {
  BatchResult,
  ConsumeOptions,
  EnqueueOptions,
  TaskMessage,
  TaskQueue,
} from './task-queue.port';
import { sleep } from '@app/common/core/backoff';

const oldestMessageAge = MetricsRegistry.gauge({
  name: 'task_queue_oldest_message_age_seconds',
  help: 'Wait time of the oldest message the last receive returned, per queue (0 when the receive was empty)',
  labels: ['queue'],
});

@Injectable()
export class SqsTaskQueue extends TaskQueue {
  private readonly logger = new Logger(SqsTaskQueue.name);
  private readonly client: SQSClient;
  private readonly urlPrefix: string;

  constructor(config: ApiConfigService) {
    super();
    const endpoint = config.get('sqs_endpoint');
    this.client = new SQSClient({
      region: config.get('aws_region') || 'eu-central-1',
      ...(endpoint && {
        endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    });
    this.urlPrefix =
      config.get('sqs_queue_url_prefix') ??
      'http://localhost:9324/000000000000/';
  }

  queueUrl(queue: string): string {
    return `${this.urlPrefix}${queue}`;
  }

  async enqueue<T>(
    queue: string,
    body: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    validateEnqueueOptions(queue, options);
    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl(queue),
        MessageBody: JSON.stringify(body),
        DelaySeconds: options.delaySeconds,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.dedupeId,
        MessageAttributes: this.attributes(options.attributes),
      }),
    );
    return res.MessageId!;
  }

  async enqueueBatch<T>(
    queue: string,
    bodies: { body: T; options?: EnqueueOptions }[],
  ): Promise<BatchResult> {
    for (const { options } of bodies) validateEnqueueOptions(queue, options);
    const result: BatchResult = { sent: 0, failed: [] };
    // SQS batch limit is 10 entries.
    for (let i = 0; i < bodies.length; i += 10) {
      const chunk = bodies.slice(i, i + 10);
      const res = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl(queue),
          Entries: chunk.map(({ body, options = {} }, j) => ({
            Id: String(i + j),
            MessageBody: JSON.stringify(body),
            DelaySeconds: options.delaySeconds,
            MessageGroupId: options.groupId,
            MessageDeduplicationId: options.dedupeId,
            MessageAttributes: this.attributes(options.attributes),
          })),
        }),
      );
      result.sent += res.Successful?.length ?? 0;
      for (const f of res.Failed ?? [])
        result.failed.push({
          index: Number(f.Id),
          reason: [f.Code, f.Message].filter(Boolean).join(': '),
        });
    }
    result.failed.sort((a, b) => a.index - b.index);
    return result;
  }

  consume<T>(
    queue: string,
    handler: (msg: TaskMessage<T>) => Promise<void>,
    {
      concurrency = 10,
      visibilityTimeoutSec = 60,
      waitTimeSec = 20,
      bodySchema,
      deadLetterQueue = queue.replace(/(\.fifo)?$/, '-dlq$1'),
    }: ConsumeOptions = {},
  ): () => Promise<void> {
    const queueUrl = this.queueUrl(queue);
    let running = true;
    const inFlight = new Set<Promise<void>>();
    const polling = new AbortController();

    const deadLetter = async (raw: Message, reason: string) => {
      const fifo = deadLetterQueue.endsWith('.fifo');
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl(deadLetterQueue),
          MessageBody: raw.Body ?? '',
          MessageGroupId: fifo ? 'dead-letter' : undefined,
          MessageDeduplicationId: fifo ? raw.MessageId : undefined,
          MessageAttributes: {
            ...Object.fromEntries(
              Object.entries(raw.MessageAttributes ?? {}).map(([k, v]) => [
                k,
                { DataType: 'String', StringValue: v.StringValue ?? '' },
              ]),
            ),
            deadLetterReason: { DataType: 'String', StringValue: reason },
            sourceQueue: { DataType: 'String', StringValue: queue },
          },
        }),
      );
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: raw.ReceiptHandle,
        }),
      );
    };

    const processOne = async (raw: Message): Promise<boolean> => {
      // Heartbeat: keep the message invisible while we work, so slow work isn't redelivered to another worker.
      const heartbeat = setInterval(
        () => {
          this.client
            .send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: raw.ReceiptHandle,
                VisibilityTimeout: visibilityTimeoutSec,
              }),
            )
            .catch((e) =>
              this.logger.warn(
                `[${queue}] visibility extension failed: ${e.message}`,
              ),
            );
        },
        (visibilityTimeoutSec * 1000) / 2,
      );

      try {
        const attributes = Object.fromEntries(
          Object.entries(raw.MessageAttributes ?? {}).map(([k, v]) => [
            k,
            v.StringValue ?? '',
          ]),
        );
        let body: unknown;
        let valid = true;
        try {
          body = JSON.parse(raw.Body ?? 'null');
        } catch (e) {
          if (!bodySchema) throw e;
          valid = false;
        }
        if (bodySchema && (!valid || !bodySchema.safeParse(body).success)) {
          await deadLetter(raw, 'SCHEMA_INVALID');
          this.logger.warn(
            `[${queue}] message ${raw.MessageId} dead-lettered: SCHEMA_INVALID`,
          );
          return true;
        }
        const parentCtx = propagation.extract(context.active(), attributes);
        await context.with(parentCtx, () =>
          handler({
            id: raw.MessageId!,
            body: body as T,
            receiveCount: Number(raw.Attributes?.ApproximateReceiveCount ?? 1),
            attributes,
          }),
        );
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: raw.ReceiptHandle,
          }),
        );
        return true;
      } catch (error) {
        // Not deleting = message becomes visible again after the timeout → retry; DLQ after maxReceiveCount.
        this.logger.error(
          `[${queue}] message ${raw.MessageId} failed: ${(error as Error).name}`,
        );
        return false;
      } finally {
        clearInterval(heartbeat);
      }
    };

    const loop = async () => {
      while (running) {
        const capacity = concurrency - inFlight.size;
        if (capacity <= 0) {
          await Promise.race(inFlight);
          continue;
        }
        try {
          const { Messages = [] } = await this.client.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: Math.min(10, capacity),
              WaitTimeSeconds: waitTimeSec,
              VisibilityTimeout: visibilityTimeoutSec,
              MessageAttributeNames: ['All'],
              MessageSystemAttributeNames: [
                'ApproximateReceiveCount',
                'MessageGroupId',
                'SentTimestamp',
              ],
            }),
            { abortSignal: polling.signal },
          );
          // Backlog age as this consumer sees it: how long the oldest message just received had waited (0 when idle).
          const sent = Messages.map((m) =>
            Number(m.Attributes?.SentTimestamp),
          ).filter(Number.isFinite);
          oldestMessageAge.set(
            sent.length
              ? Math.max(0, (Date.now() - Math.min(...sent)) / 1000)
              : 0,
            { queue },
          );
          // One receive can return several messages of the same FIFO group: handle them one at a time,
          // and after a failure leave the rest of that group for redelivery so order is kept.
          const byGroup = new Map<string, Message[]>();
          for (const message of Messages) {
            const key =
              message.Attributes?.MessageGroupId ?? message.MessageId!;
            byGroup.set(key, [...(byGroup.get(key) ?? []), message]);
          }
          for (const messages of byGroup.values()) {
            const task: Promise<void> = (async () => {
              for (const message of messages) {
                if (!(await processOne(message))) break;
              }
            })().finally(() => inFlight.delete(task));
            inFlight.add(task);
          }
        } catch (error) {
          if (!running) break;
          this.logger.error(
            `[${queue}] receive failed: ${(error as Error).message}`,
          );
          await sleep(1_000);
        }
      }
    };

    const loopDone = loop();

    return async () => {
      running = false;
      polling.abort();
      await loopDone;
      await Promise.allSettled(inFlight);
    };
  }

  private attributes(extra: Record<string, string> = {}) {
    const carrier: Record<string, string> = { ...extra };
    propagation.inject(context.active(), carrier);
    return Object.fromEntries(
      Object.entries(carrier).map(([k, v]) => [
        k,
        { DataType: 'String', StringValue: v },
      ]),
    );
  }
}
