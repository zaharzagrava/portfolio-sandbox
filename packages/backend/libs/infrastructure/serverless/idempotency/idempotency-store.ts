import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Idempotency, type IdempotencyOptions } from './idempotency';
import { manifestEntry } from '../manifest/function-info';

/**
 * The idempotency facility of a function with the table and endpoint taken from the environment of the Lambda
 * (`IDEMPOTENCY_TABLE`, else `<DYNAMO_TABLE_PREFIX>Idempotency`; `DYNAMO_ENDPOINT` locally) and the function timeout
 * from the manifest, so a lease below the timeout is refused. Create it at module scope: the client is built on the
 * first use (the environment may be loaded after the module) and reused by warm invocations.
 */
export function idempotencyFor(
  functionName: string,
  options: IdempotencyOptions = {},
): Pick<Idempotency, 'run'> {
  let instance: Idempotency | undefined;
  const create = (): Idempotency => {
    const endpoint = process.env.DYNAMO_ENDPOINT;
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-central-1',
      ...(endpoint && {
        endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
      maxAttempts: 3,
    });
    const doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    const table =
      process.env.IDEMPOTENCY_TABLE ??
      `${process.env.DYNAMO_TABLE_PREFIX ?? ''}Idempotency`;
    return new Idempotency(doc, table, functionName, {
      functionTimeoutMs: manifestEntry(functionName).timeoutSec * 1000,
      ...options,
    });
  };
  return {
    run: (key, work, runOptions) =>
      (instance ??= create()).run(key, work, runOptions),
  };
}
