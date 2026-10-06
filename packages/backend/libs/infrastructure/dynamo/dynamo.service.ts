import { Injectable } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ApiConfigService } from '@app/common/config/api-config.service';

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
      ...(endpoint && { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
      maxAttempts: 3,
    });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
    this.prefix = config.get('dynamo_table_prefix') ?? '';
  }

  table(name: string): string {
    return `${this.prefix}${name}`;
  }
}
