import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ApiConfigService } from '@app/common/config';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { DeliveryLineProducer, LineEnqueueOptions } from '../domain/ports';
import type { DeliveryLine, DeliveryMessage } from '../domain/types';
import { DELIVERY_LINES } from './delivery-lines';
import {
  CALLBACK_QUEUE_NAME,
  deadLetterQueueOf,
  lineQueueOf,
} from './notifications.topics';
import { shardName } from '@app/common/shard';

/**
 * `DELIVERY_LINE_PRODUCER` over the task queue: a delivery goes on the line of its channel and kind (transactional or
 * marketing), so a backlog on one line never delays another (P0618). The queue is a standard queue: a duplicate message
 * is possible and harmless, because the worker claims each delivery id before it sends (research R-10).
 *
 * Against the local queue stand-in (a custom SQS endpoint) the lines are created at startup when missing; in the cloud
 * they are provisioned with the rest of the infrastructure.
 */
@Injectable()
export class SqsDeliveryLineProducer
  implements DeliveryLineProducer, OnModuleInit
{
  private readonly logger = new Logger(SqsDeliveryLineProducer.name);

  constructor(
    private readonly queue: TaskQueue,
    private readonly config: ApiConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('sqs_endpoint')) await this.ensureLocalLines();
  }

  async enqueue(
    line: DeliveryLine,
    channel: DeliveryMessage['channel'],
    message: DeliveryMessage,
    options: LineEnqueueOptions,
  ): Promise<void> {
    await this.queue.enqueue(lineQueueOf(line, channel), message, {
      ...(options.delaySeconds !== undefined && {
        delaySeconds: options.delaySeconds,
      }),
    });
  }

  private async ensureLocalLines(): Promise<void> {
    const client = new SQSClient({
      region: this.config.get('aws_region') || 'eu-central-1',
      endpoint: this.config.get('sqs_endpoint'),
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    try {
      const names = [
        ...DELIVERY_LINES.map((line) => line.queue),
        CALLBACK_QUEUE_NAME,
      ];
      for (const name of names) {
        try {
          const dlq = await client.send(
            new CreateQueueCommand({
              QueueName: shardName(deadLetterQueueOf(name)),
            }),
          );
          const { Attributes } = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: dlq.QueueUrl,
              AttributeNames: ['QueueArn'],
            }),
          );
          await client.send(
            new CreateQueueCommand({
              QueueName: shardName(name),
              Attributes: {
                VisibilityTimeout: '60',
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: Attributes?.QueueArn,
                  maxReceiveCount: 5,
                }),
              },
            }),
          );
        } catch (error) {
          // The line exists with other attributes (created from the stand-in's config file): use it as it is.
          this.logger.debug(
            `delivery line ${name} not (re)created: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      client.destroy();
    }
  }
}
