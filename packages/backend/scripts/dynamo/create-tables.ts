/**
 * Creates DynamoDB tables from packages/backend/dynamodb/*.json (CreateTable
 * input) against DynamoDB Local. In AWS the same JSON files feed the
 * Terraform `dynamodb` module (O-03), so key design lives in one place.
 *
 * Usage: DYNAMO_ENDPOINT=http://localhost:8100 DYNAMO_TABLE_PREFIX=local_ npx ts-node scripts/dynamo/create-tables.ts
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateTableCommand,
  CreateTableCommandInput,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

type TableDefinition = CreateTableCommandInput & { TimeToLiveAttribute?: string };

async function main() {
  const dir = join(__dirname, '../../dynamodb');
  const prefix = process.env.DYNAMO_TABLE_PREFIX ?? '';
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'eu-central-1',
    endpoint: process.env.DYNAMO_ENDPOINT ?? 'http://localhost:8100',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    // `_design` documents the key design next to the schema; it's not part of CreateTable.
    const { TimeToLiveAttribute, _design, ...definition } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as TableDefinition & { _design?: unknown };
    void _design;
    const TableName = `${prefix}${definition.TableName}`;
    try {
      await client.send(new CreateTableCommand({ ...definition, TableName, BillingMode: 'PAY_PER_REQUEST' }));
      console.log(`created ${TableName}`);
    } catch (error) {
      if (!(error instanceof ResourceInUseException)) throw error;
      console.log(`exists  ${TableName}`);
    }
    if (TimeToLiveAttribute) {
      await client
        .send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: TimeToLiveAttribute } }))
        .catch(() => undefined); // already enabled
    }
  }
  client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
