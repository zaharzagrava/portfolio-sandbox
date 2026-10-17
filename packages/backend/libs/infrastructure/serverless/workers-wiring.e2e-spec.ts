import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { defineSqsHandler } from './batch/define-sqs-handler';
import { Idempotency } from './idempotency/idempotency';
import { idempotencyKey } from './idempotency/idempotency-key';
import {
  startRunner,
  type LambdaHandler,
  type RunnerHandle,
} from './runner/runner';
import {
  captureTelemetry,
  EffectCounter,
  waitFor,
  type Capture,
} from './testing';
import {
  createTestQueue,
  depth,
  entryFor,
  send,
  SQS_PREFIX,
  testSqsClient,
  writeManifest,
  type TestQueue,
} from './testing/queues';

config({ path: '.env.test', quiet: true });
const backend = resolve(__dirname, '../../..');

/** The functions wired the way they run: through the runner, with real stores (DynamoDB Local, ElasticMQ, Postgres). */
describe('Lambda workers wiring (e2e)', () => {
  const raw = testSqsClient();
  const queues: TestQueue[] = [];
  const handles: RunnerHandle[] = [];
  let capture: Capture;
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: 'eu-central-1',
      endpoint: process.env.DYNAMO_ENDPOINT ?? 'http://localhost:8101',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
  );
  const table = `${process.env.DYNAMO_TABLE_PREFIX ?? 'test_'}Idempotency`;

  const queue = async (options?: Parameters<typeof createTestQueue>[1]) => {
    const q = await createTestQueue(raw, { maxReceive: 5, ...options });
    queues.push(q);
    return q;
  };
  async function start(
    q: TestQueue,
    name: string,
    handler: LambdaHandler,
    sqs: Pick<SQSClient, 'send'> = raw,
    overrides = {},
  ) {
    const { manifestPath } = writeManifest([entryFor(name, q, overrides)]);
    const handle = await startRunner({
      manifestPath,
      sqs,
      queueUrlPrefix: SQS_PREFIX,
      waitTimeSeconds: 1,
      maxConcurrency: 1,
      loadHandler: () => handler,
    });
    handles.push(handle);
    return handle;
  }

  beforeEach(() => (capture = captureTelemetry()));
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.stop()));
    await Promise.all(queues.splice(0).map((q) => q.cleanup()));
    capture.restore();
  });

  describe('a fixture function guarded by an idempotency record', () => {
    const body = z.object({ key: z.string() });
    function fixture(
      effects: EffectCounter,
      fnName: string,
      responses: unknown[] = [],
    ): LambdaHandler {
      const idem = new Idempotency(doc, table, fnName);
      const handler = defineSqsHandler({
        function: {
          name: fnName,
          queue: 'fixture',
          fifo: false,
          maxReceiveCount: 5,
        },
        bodySchema: body,
        handle: async (message) => {
          await idem.run(
            idempotencyKey(fnName, message.body.key),
            async () => effects.write(message.body.key),
            { leaseMs: 30_000 },
          );
        },
      });
      return async (event, context) => {
        const response = await handler(event, context);
        responses.push(response);
        return response;
      };
    }
    const record = async (fnName: string, key: string) =>
      (
        await doc.send(
          new GetCommand({
            TableName: table,
            Key: { PK: `${fnName}#${fnName}#${key}` },
            ConsistentRead: true,
          }),
        )
      ).Item;

    it('S55 AS-26: the same message delivered twice produces one effect, the second invocation reports no failure and the record is COMPLETED', async () => {
      const q = await queue();
      const fnName = `fixture-${randomUUID().slice(0, 8)}`;
      const key = randomUUID();
      const effects = new EffectCounter();
      const responses: unknown[] = [];
      await send(raw, q, JSON.stringify({ key }));
      // the queue service loses the first acknowledgement, as it can in production: the message comes back (receive count 2)
      let lost = false;
      const lossy = {
        send: (command: any, ...rest: any[]) => {
          if (command instanceof DeleteMessageBatchCommand && !lost) {
            lost = true;
            return Promise.resolve({
              Successful: [],
              Failed: (command.input.Entries ?? []).map((e) => ({
                Id: e.Id,
                Code: 'InternalError',
                SenderFault: false,
              })),
            });
          }
          return (raw.send as any)(command, ...rest);
        },
      } as unknown as SQSClient;
      await start(q, fnName, fixture(effects, fnName, responses), lossy);
      await waitFor(() => responses.length >= 2, { timeoutMs: 25_000 });
      expect(responses[1]).toEqual({ batchItemFailures: [] });
      expect(effects.count(key)).toBe(1);
      expect(await record(fnName, key)).toMatchObject({ status: 'COMPLETED' });
      await waitFor(async () => (await depth(raw, q.url)) === 0);
      expect(capture.metrics('IdempotencyReplay')).toHaveLength(1);
    });

    it('S55 AS-27: two messages with different IDs but one business key produce one effect and both are acknowledged', async () => {
      const q = await queue();
      const fnName = `fixture-${randomUUID().slice(0, 8)}`;
      const key = randomUUID();
      const effects = new EffectCounter();
      await send(raw, q, JSON.stringify({ key }));
      await send(raw, q, JSON.stringify({ key })); // a producer re-send after the dedupe window: another message ID
      await start(q, fnName, fixture(effects, fnName));
      await waitFor(async () => (await depth(raw, q.url)) === 0);
      expect(effects.count(key)).toBe(1);
      expect(await record(fnName, key)).toMatchObject({ status: 'COMPLETED' });
    });
  });

  describe('document-extractor-dlq (the built bundle, real Postgres)', () => {
    const bundle = resolve(
      backend,
      'dist/lambda-bundles/document-extractor-dlq/index.js',
    );
    let db: Client;
    let handler: LambdaHandler;
    const stdout: string[] = [];
    let spy: jest.SpyInstance;
    const created: string[] = [];

    beforeAll(async () => {
      if (!existsSync(bundle))
        execFileSync(process.execPath, ['scripts/build-lambdas.mjs'], {
          cwd: backend,
          stdio: 'pipe',
          timeout: 540_000,
        });
      const env = process.env;
      db = new Client({
        connectionString: `postgres://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`,
      });
      await db.connect();
      handler = (createRequire(bundle)(bundle) as { handler: LambdaHandler })
        .handler;
    }, 600_000);
    beforeEach(() => {
      stdout.length = 0;
      const write = process.stdout.write.bind(process.stdout);
      spy = jest.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: any,
        ...rest: any[]
      ) => {
        stdout.push(String(chunk));
        return (write as any)(chunk, ...rest);
      }) as typeof process.stdout.write);
    });
    afterEach(() => spy.mockRestore());
    afterAll(async () => {
      for (const id of created) {
        await db.query(`DELETE FROM "ReviewTask" WHERE "documentId" = $1`, [
          id,
        ]);
        await db.query(
          `DELETE FROM "OnboardingStatusHistory" WHERE "entityId" = $1`,
          [id],
        );
        await db.query(`DELETE FROM "ShopDocument" WHERE id = $1`, [id]);
      }
      await db.query(`DROP FUNCTION IF EXISTS s55_fail_review() CASCADE`);
      await db.end();
    });

    const queued = async () => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey", status, size)
         VALUES ($1, $2, 'BANK_STATEMENT', 'application/pdf', $3, $4, 'QUEUED', 100)`,
        [
          id,
          randomUUID(),
          id.replace(/-/g, '').repeat(2),
          `kyc/s55-wiring/${id}`,
        ],
      );
      created.push(id);
      return id;
    };
    const status = async (id: string) =>
      (await db.query(`SELECT status FROM "ShopDocument" WHERE id = $1`, [id]))
        .rows[0].status as string;
    const openTasks = async (id: string) =>
      (
        await db.query(
          `SELECT reasons FROM "ReviewTask" WHERE "documentId" = $1 AND status = 'OPEN'`,
          [id],
        )
      ).rows;
    const metricLines = (name: string) =>
      stdout
        .join('')
        .split('\n')
        .filter((l) => l.includes(`"${name}"`) && l.includes('_aws'));

    it('S55 AS-34: a dead-lettered message sends its document to review once and the queue ends empty', async () => {
      const q = await queue();
      const id = await queued();
      await send(raw, q, JSON.stringify({ documentId: id }));
      await start(q, 'document-extractor-dlq', handler);
      await waitFor(async () => (await status(id)) === 'NEEDS_REVIEW', {
        timeoutMs: 30_000,
      });
      const tasks = await openTasks(id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].reasons).toEqual([
        expect.objectContaining({ code: 'extraction_unavailable' }),
      ]);
      await waitFor(async () => (await depth(raw, q.url)) === 0);
    });

    it('S55 AS-35: when routing fails the message stays and is retried after the visibility timeout; a duplicate after success routes once', async () => {
      const q = await queue();
      const id = await queued();
      // fault at the database edge: opening a review task for this document fails until the trigger is dropped
      await db.query(`CREATE OR REPLACE FUNCTION s55_fail_review() RETURNS trigger AS $$
        BEGIN IF NEW."documentId" = '${id}' THEN RAISE EXCEPTION 'review store unavailable (s55 fault)'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await db.query(
        `CREATE TRIGGER s55_fail_review BEFORE INSERT ON "ReviewTask" FOR EACH ROW EXECUTE FUNCTION s55_fail_review()`,
      );
      try {
        await send(raw, q, JSON.stringify({ documentId: id }));
        await start(q, 'document-extractor-dlq', handler);
        await waitFor(() => metricLines('DeadLetterHandlerFailed').length > 0, {
          timeoutMs: 30_000,
        });
        expect(await openTasks(id)).toHaveLength(0);
        expect(await depth(raw, q.url)).toBe(1); // not lost
      } finally {
        await db.query(
          `DROP TRIGGER IF EXISTS s55_fail_review ON "ReviewTask"`,
        );
      }
      await waitFor(async () => (await status(id)) === 'NEEDS_REVIEW', {
        timeoutMs: 30_000,
      }); // retried after the visibility timeout
      await waitFor(async () => (await depth(raw, q.url)) === 0);

      // a duplicate delivery after the success changes nothing
      await raw.send(
        new SendMessageCommand({
          QueueUrl: q.url,
          MessageBody: JSON.stringify({ documentId: id }),
        }),
      );
      await waitFor(async () => (await depth(raw, q.url)) === 0);
      expect(await openTasks(id)).toHaveLength(1);
    });
  });
});
