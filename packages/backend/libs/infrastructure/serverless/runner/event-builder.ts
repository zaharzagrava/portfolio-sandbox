import type { Message } from '@aws-sdk/client-sqs';
import type { SqsEvent, SqsRecord } from '../batch/sqs-types';

/** The SQS → Lambda record for one received message: the shape the Lambda service passes (S55 AS-38). */
export function buildRecord(
  message: Message,
  source: { arn: string; region: string },
): SqsRecord {
  const attributes = message.Attributes ?? {};
  const messageAttributes = Object.fromEntries(
    Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [
      name,
      {
        ...(value.StringValue !== undefined && {
          stringValue: value.StringValue,
        }),
        dataType: value.DataType ?? 'String',
      },
    ]),
  );
  return {
    messageId: message.MessageId ?? '',
    receiptHandle: message.ReceiptHandle ?? '',
    body: message.Body ?? '',
    attributes: {
      ApproximateReceiveCount: attributes.ApproximateReceiveCount ?? '1',
      SentTimestamp: attributes.SentTimestamp,
      SenderId: attributes.SenderId,
      ApproximateFirstReceiveTimestamp:
        attributes.ApproximateFirstReceiveTimestamp,
      ...(attributes.MessageGroupId !== undefined && {
        MessageGroupId: attributes.MessageGroupId,
      }),
      ...(attributes.MessageDeduplicationId !== undefined && {
        MessageDeduplicationId: attributes.MessageDeduplicationId,
      }),
      ...(attributes.SequenceNumber !== undefined && {
        SequenceNumber: attributes.SequenceNumber,
      }),
    },
    messageAttributes,
    md5OfBody: message.MD5OfBody ?? '',
    eventSource: 'aws:sqs',
    eventSourceARN: source.arn,
    awsRegion: source.region,
  };
}

export function buildEvent(
  messages: Message[],
  source: { arn: string; region: string },
): SqsEvent {
  return { Records: messages.map((m) => buildRecord(m, source)) };
}
