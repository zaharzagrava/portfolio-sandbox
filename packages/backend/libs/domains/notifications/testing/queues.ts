import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ApiConfigService } from '@app/common/config';
import { waitFor } from '@app/test/utils/async-helpers';
import { DELIVERY_LINES } from '../infra/delivery-lines';
import {
  CALLBACK_QUEUE_NAME,
  deadLetterQueueOf,
} from '../infra/notifications.topics';
import type { NotificationsTestApp } from './notifications-app';

/** Drops every message of the six delivery lines and their dead-letter queues (a spec's clean start). */
export async function purgeDeliveryLines(
  t: NotificationsTestApp,
): Promise<void> {
  const config = t.app.get(ApiConfigService);
  const prefix =
    config.get('sqs_queue_url_prefix') ?? 'http://localhost:9324/000000000000/';
  const client = new SQSClient({
    region: config.get('aws_region') || 'eu-central-1',
    endpoint: config.get('sqs_endpoint'),
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    const names = [
      ...DELIVERY_LINES.flatMap((l) => [l.queue, l.deadLetterQueue]),
      CALLBACK_QUEUE_NAME,
      deadLetterQueueOf(CALLBACK_QUEUE_NAME),
    ];
    for (const name of names)
      await client.send(
        new PurgeQueueCommand({ QueueUrl: `${prefix}${name}` }),
      );
  } finally {
    client.destroy();
  }
}

/** Messages a queue still holds: waiting, in flight and delayed. */
export async function queueDepth(
  t: NotificationsTestApp,
  queue: string,
): Promise<number> {
  const config = t.app.get(ApiConfigService);
  const prefix =
    config.get('sqs_queue_url_prefix') ?? 'http://localhost:9324/000000000000/';
  const client = new SQSClient({
    region: config.get('aws_region') || 'eu-central-1',
    endpoint: config.get('sqs_endpoint'),
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    const { Attributes = {} } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: `${prefix}${queue}`,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    return Object.values(Attributes).reduce((n, v) => n + Number(v), 0);
  } finally {
    client.destroy();
  }
}

/**
 * Waits until every message put on `queue` so far was handled and deleted (the line workers ran to the end), twice in a
 * row so a message in the gap between receive and delete is not missed. Specs use it before asserting "nothing else
 * was sent", instead of sleeping.
 */
export async function waitForQueueEmpty(
  t: NotificationsTestApp,
  queue: string,
): Promise<void> {
  let quiet = 0;
  await waitFor(
    async () => {
      quiet = (await queueDepth(t, queue)) === 0 ? quiet + 1 : 0;
      return quiet >= 3;
    },
    { description: `queue ${queue} empty`, intervalMs: 150, timeoutMs: 45_000 },
  );
}
