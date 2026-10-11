import { Injectable } from '@nestjs/common';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ApiConfigService } from '@app/common/config';

/**
 * Thin wrapper: the DocumentClient + environment-aware table names
 * (`<prefix><Table>` so test/local/prod tables never collide). Domain
 * repositories own their key design (documented next to each table JSON in
 * `packages/backend/dynamodb/`).
 */
@Injectable()
export class DynamoService {
  readonly doc: DynamoDBDocumentClient;
  private readonly prefix: string;

  constructor(config: ApiConfigService) {
    const endpoint = config.get('dynamo_endpoint');
    const client = new DynamoDBClient({
      region: config.get('aws_region') || 'eu-central-1',
      ...(endpoint && {
        endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
      maxAttempts: 3,
    });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
    this.prefix = config.get('dynamo_table_prefix') ?? '';
  }

  table(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Set once an endpoint answers "unsupported operation" for `TransactWriteItems` (ScyllaDB Alternator, the dev store). */
  private transactionsUnsupported = false;

  /**
   * `TransactWriteItems`, with one dev-stack accommodation: ScyllaDB Alternator does not implement the operation, so
   * against such an endpoint the same items run one by one, in order (updates first: they carry the optimistic locks),
   * each with its own condition; the first failed condition throws a `TransactionCanceledException` like the real call
   * does. DynamoDB and DynamoDB Local never take that path, so production keeps all-or-nothing semantics.
   */
  async transactWrite(
    items: NonNullable<TransactWriteCommandInput['TransactItems']>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void> {
    if (!this.transactionsUnsupported) {
      try {
        await this.doc.send(
          new TransactWriteCommand({ TransactItems: items }),
          options,
        );
        return;
      } catch (error) {
        if ((error as { name?: string }).name !== 'UnknownOperationException')
          throw error;
        this.transactionsUnsupported = true;
      }
    }
    const ordered = [
      ...items.filter((item) => item.Update),
      ...items.filter((item) => !item.Update),
    ];
    for (const item of ordered) {
      try {
        if (item.Update) await this.doc.send(new UpdateCommand(item.Update), options);
        else if (item.Put) await this.doc.send(new PutCommand(item.Put), options);
        else if (item.Delete) await this.doc.send(new DeleteCommand(item.Delete), options);
        else throw new Error('transactWrite fallback: unsupported item type');
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException)
          throw new TransactionCanceledException({
            message: 'Transaction cancelled, a condition was not met',
            $metadata: error.$metadata,
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
          });
        throw error;
      }
    }
  }
}
