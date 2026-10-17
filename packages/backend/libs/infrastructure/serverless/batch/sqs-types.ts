/** SQS → Lambda event shapes (subset; avoids a dependency on @types/aws-lambda). */
export interface SqsMessageAttribute {
  stringValue?: string;
  dataType: string;
}

export interface SqsRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: {
    ApproximateReceiveCount: string;
    MessageGroupId?: string;
    MessageDeduplicationId?: string;
    SequenceNumber?: string;
    SentTimestamp?: string;
    SenderId?: string;
    ApproximateFirstReceiveTimestamp?: string;
  };
  messageAttributes?: Record<string, SqsMessageAttribute>;
  md5OfBody?: string;
  eventSource?: string;
  eventSourceARN: string;
  awsRegion?: string;
}

export interface SqsEvent {
  Records: SqsRecord[];
}

export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** The part of the Lambda context the toolkit uses. */
export interface InvocationContext {
  getRemainingTimeInMillis(): number;
}
