import { getConnectionToken } from '@nestjs/sequelize';
import { NestFactory } from '@nestjs/core';
import { QueryTypes, type Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { ExtractionService } from '@app/domains/seller-onboarding';
import { nestContext } from '../shared/nest-context';
import type { SqsEvent } from '../shared/sqs-batch';
import {
  DocumentExtractorModule,
  handler as extractorHandler,
} from './document-extractor';
import { handler as deadLetterHandler } from './document-extractor-dlq';

const sqs = (...bodies: string[]): SqsEvent => ({
  Records: bodies.map((body, i) => ({
    messageId: `m${i}`,
    receiptHandle: `r${i}`,
    body,
    attributes: { ApproximateReceiveCount: '1' },
    eventSourceARN:
      'arn:aws:sqs:eu-central-1:000000000000:onboarding-documents',
  })),
});

/**
 * The two Lambdas of the extraction queue against the real database (S04 FR-026, FR-027), in their own Nest application
 * (`DocumentExtractorModule`: the extraction module only, L-018). The documents are seeded with SQL: the spec needs no
 * API, no model and no object storage, because none of the cases below reaches them.
 */
describe('Seller onboarding: extraction Lambdas (e2e)', () => {
  let db: Sequelize;
  const created: string[] = [];

  beforeAll(async () => {
    const context = await nestContext(DocumentExtractorModule);
    db = context.get(getConnectionToken());
  });
  afterAll(async () => {
    for (const id of created) {
      await db.query(`DELETE FROM "ReviewTask" WHERE "documentId" = :id`, {
        replacements: { id },
      });
      await db.query(
        `DELETE FROM "OnboardingStatusHistory" WHERE "entityId" = :id`,
        {
          replacements: { id },
        },
      );
      await db.query(`DELETE FROM "ShopDocument" WHERE id = :id`, {
        replacements: { id },
      });
    }
  });

  const rows = <T extends object>(sql: string, replacements = {}) =>
    db.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  /** A document waiting in the queue, in a shop that has no other data. */
  const queued = async () => {
    const id = v4();
    await db.query(
      `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey", status, size)
       VALUES (:id, :shopId, 'BANK_STATEMENT', 'application/pdf', :hash, :key, 'QUEUED', 100)`,
      {
        replacements: {
          id,
          shopId: v4(),
          hash: id.replace(/-/g, '').repeat(2),
          key: `kyc/lambda-spec/${id}`,
        },
      },
    );
    created.push(id);
    return id;
  };
  const status = async (id: string) =>
    (
      await rows<{ status: string }>(
        `SELECT status FROM "ShopDocument" WHERE id = :id`,
        { id },
      )
    )[0]!.status;

  it('S04 AS-34: invalid bodies are failed items without side effects; the rest of the batch is processed', async () => {
    const id = await queued();
    const snapshot = () =>
      rows(
        `SELECT id, status, "leaseUntil" FROM "ShopDocument" WHERE id = :id`,
        { id },
      );
    const before = await snapshot();
    const result = await extractorHandler(
      sqs(
        'not json',
        JSON.stringify({}),
        JSON.stringify({ documentId: 'not-a-uuid' }),
        JSON.stringify({ documentId: v4(), extra: 1 }),
        JSON.stringify({ documentId: v4() }), // a valid body for an unknown document: acknowledged
      ),
    );
    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
    ]);
    expect(await snapshot()).toEqual(before);
    expect(await status(id)).toBe('QUEUED');
  });

  it('S04 AS-32: the dead-letter handler sends the document to review once, however often it runs', async () => {
    const id = await queued();
    const body = JSON.stringify({ documentId: id });
    for (let i = 0; i < 2; i++) {
      const result = await deadLetterHandler(sqs(body));
      expect(result.batchItemFailures).toEqual([]);
    }
    expect(await status(id)).toBe('NEEDS_REVIEW');
    const tasks = await rows<{ reasons: Array<{ code: string }> }>(
      `SELECT reasons FROM "ReviewTask" WHERE "documentId" = :id AND status = 'OPEN'`,
      { id },
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reasons).toEqual([
      expect.objectContaining({ code: 'extraction_unavailable' }),
    ]);
    const attempts = await rows(
      `SELECT 1 FROM "DocumentExtraction" WHERE "documentId" = :id`,
      { id },
    );
    expect(attempts).toEqual([]); // the model was never called
  });

  it('S04 AS-32: a dead-lettered message with an invalid body is acknowledged, not retried', async () => {
    const result = await deadLetterHandler(
      sqs('not json', JSON.stringify({ documentId: 'nope' })),
    );
    expect(result.batchItemFailures).toEqual([]);
  });

  // last: closing a second application context closes the pool the first one shares
  it("S04 AS-62: the Lambda's own app starts with the extraction module and without ClickHouse, billing or assistant (L-018)", async () => {
    const context = await NestFactory.createApplicationContext(
      DocumentExtractorModule,
      { logger: false, abortOnError: false },
    );
    const names = [
      ...(
        context as unknown as {
          container: {
            getModules(): Map<string, { metatype?: { name: string } }>;
          };
        }
      ).container
        .getModules()
        .values(),
    ].map((m) => m.metatype?.name ?? '');
    expect(names).toContain('OnboardingExtractionModule');
    for (const forbidden of [
      'ClickHouseModule',
      'BillingModule',
      'AssistantModule',
    ])
      expect(names).not.toContain(forbidden);
    expect(context.get(ExtractionService)).toBeDefined();
  }, 60_000);
});
