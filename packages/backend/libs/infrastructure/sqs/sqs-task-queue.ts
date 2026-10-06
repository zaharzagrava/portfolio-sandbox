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
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ConsumeOptions, EnqueueOptions, TaskMessage, TaskQueue } from './task-queue.port';
import { sleep } from '@app/common/core/backoff';

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
      ...(endpoint && { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
    });
    this.urlPrefix = config.get('sqs_queue_url_prefix') ?? 'http://localhost:9324/000000000000/';
  }

  queueUrl(queue: string): string {
    return `${this.urlPrefix}${queue}`;
  }

  async enqueue<T>(queue: string, body: T, options: EnqueueOptions = {}): Promise<string> {
    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl(queue),
        MessageBody: JSON.stringify(body),
        DelaySeconds: options.groupId ? undefined : options.delaySeconds,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
        MessageAttributes: this.attributes(options.attributes),
      }),
    );
    return res.MessageId!;
  }

  async enqueueBatch<T>(queue: string, bodies: { body: T; options?: EnqueueOptions }[]): Promise<void> {
    // SQS batch limit is 10 entries.
    for (let i = 0; i < bodies.length; i += 10) {
      const chunk = bodies.slice(i, i + 10);
      const res = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl(queue),
          Entries: chunk.map(({ body, options = {} }, j) => ({
            Id: String(i + j),
            MessageBody: JSON.stringify(body),
            DelaySeconds: options.groupId ? undefined : options.delaySeconds,
            MessageGroupId: options.groupId,
            MessageDeduplicationId: options.deduplicationId,
            MessageAttributes: this.attributes(options.attributes),
          })),
        }),
      );
      if (res.Failed?.length) {
        throw new Error(`SQS batch partially failed: ${res.Failed.map((f) => f.Code).join(', ')}`);
      }
    }
  }

  consume<T>(
    queue: string,
    handler: (msg: TaskMessage<T>) => Promise<void>,
    { concurrency = 10, visibilityTimeoutSec = 60, waitTimeSec = 20 }: ConsumeOptions = {},
  ): () => Promise<void> {
    const queueUrl = this.queueUrl(queue);
    let running = true;
    const inFlight = new Set<Promise<void>>();

    const processOne = async (raw: Message) => {
      // Heartbeat: keep the message invisible while we work, so slow work isn't redelivered to another worker.
      const heartbeat = setInterval(() => {
        this.client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: raw.ReceiptHandle,
              VisibilityTimeout: visibilityTimeoutSec,
            }),
          )
          .catch((e) => this.logger.warn(`[${queue}] visibility extension failed: ${e.message}`));
      }, (visibilityTimeoutSec * 1000) / 2);

      try {
        const attributes = Object.fromEntries(
          Object.entries(raw.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        );
        const parentCtx = propagation.extract(context.active(), attributes);
        await context.with(parentCtx, () =>
          handler({
            id: raw.MessageId!,
            body: JSON.parse(raw.Body ?? 'null') as T,
            receiveCount: Number(raw.Attributes?.ApproximateReceiveCount ?? 1),
            attributes,
          }),
        );
        await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: raw.ReceiptHandle }));
      } catch (error) {
        // Not deleting = message becomes visible again after the timeout → retry; DLQ after maxReceiveCount.
        this.logger.error(`[${queue}] message ${raw.MessageId} failed: ${(error as Error).message}`);
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
              MessageSystemAttributeNames: ['ApproximateReceiveCount'],
            }),
          );
          for (const message of Messages) {
            const task = processOne(message).finally(() => inFlight.delete(task));
            inFlight.add(task);
          }
        } catch (error) {
          this.logger.error(`[${queue}] receive failed: ${(error as Error).message}`);
          await sleep(1_000);
        }
      }
    };

    const loopDone = loop();

    return async () => {
      running = false;
      await loopDone;
      await Promise.allSettled(inFlight);
    };
  }

  private attributes(extra: Record<string, string> = {}) {
    const carrier: Record<string, string> = { ...extra };
    propagation.inject(context.active(), carrier);
    return Object.fromEntries(Object.entries(carrier).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]));
  }
}
