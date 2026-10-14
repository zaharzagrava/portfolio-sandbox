import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { generateTestingModule } from '@app/test/utils/global-modules';

/* eslint-disable @typescript-eslint/no-require-imports -- migrations are plain CommonJS files run by sequelize-cli */
const legacy = require('../../../migrations/20261002160000-knowledge-base.js');
const expand = require('../../../migrations/20261013160000-knowledge-s47-expand.js');
const backfill = require('../../../migrations/20261013160100-knowledge-s47-backfill.js');
const contract = require('../../../migrations/20261013160200-knowledge-s47-contract.js');
/* eslint-enable @typescript-eslint/no-require-imports */

interface Migration {
  up(queryInterface: unknown): Promise<void>;
  down(queryInterface: unknown): Promise<void>;
}

const ID = {
  shop: '0192f7a0-0000-7000-8000-00000000a001',
  product: '0192f7a0-0000-7000-8000-00000000c001',
  ready: '0192f7a0-0000-7000-8000-0000000000e1',
  failedPdf: '0192f7a0-0000-7000-8000-0000000000e2',
  failedEmbed: '0192f7a0-0000-7000-8000-0000000000e3',
  failedOther: '0192f7a0-0000-7000-8000-0000000000e4',
  queued: '0192f7a0-0000-7000-8000-0000000000e5',
  deleted: '0192f7a0-0000-7000-8000-0000000000e6',
};

/**
 * S47 migrations (expand → backfill) on a scratch database that starts from the legacy knowledge schema, so the
 * backfill sees legacy rows. The shared test database already has the new schema and is not touched.
 */
describe('RAG: configuration, observability, boundaries (schema)', () => {
  let app: INestApplication;
  let admin: Sequelize;
  let db: Sequelize;
  const name = `s47_mig_${process.pid}_${Date.now() % 100000}`;

  const rows = <T extends object>(sql: string) =>
    db.query<T>(sql, { type: QueryTypes.SELECT });
  const run = (migration: Migration, direction: 'up' | 'down') =>
    migration[direction](db.getQueryInterface());
  const columns = async (table: string) =>
    (
      await rows<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = '${table}'`,
      )
    ).reduce<Record<string, boolean>>(
      (all, c) => ({ ...all, [c.column_name]: c.is_nullable === 'YES' }),
      {},
    );
  const snapshot = async () => ({
    documents: await rows(
      `SELECT "id","failureCode","queuedAt","deletedAt","contentSize","status" FROM "KnowledgeDocument" ORDER BY "id"`,
    ),
    chunks: await rows(
      `SELECT "id","embeddingModel","tokens" FROM "KnowledgeChunk" ORDER BY "id"`,
    ),
  });

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([]);
    app = moduleRef.createNestApplication();
    await app.init();
    const shared = app.get(Sequelize);
    const { host, port, username, password } = shared.config as unknown as {
      host: string;
      port: number;
      username: string;
      password: string;
    };
    const connect = (database: string) =>
      new Sequelize({
        dialect: 'postgres',
        host,
        port,
        username,
        password,
        database,
        logging: false,
      });
    admin = connect('postgres');
    await admin.query(`CREATE DATABASE "${name}"`);
    db = connect(name);

    // The tables the legacy knowledge schema pointed at (their owners are other domains).
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE "Shop" ("id" UUID PRIMARY KEY);
      CREATE TABLE "Product" ("id" UUID PRIMARY KEY);
    `);
    await run(legacy, 'up');
    const doc = (
      id: string,
      status: string,
      error: string | null,
      extra = '',
    ) =>
      `('${id}','${ID.shop}',NULL,'PUBLIC','Doc ${id.slice(-2)}','MARKDOWN','knowledge/x/${id}','${id.slice(-2).repeat(32)}','${status}',${error ? `'${error}'` : 'NULL'}${extra})`;
    await db.query(`
      INSERT INTO "Shop" ("id") VALUES ('${ID.shop}');
      INSERT INTO "Product" ("id") VALUES ('${ID.product}');
      INSERT INTO "KnowledgeDocument" ("id","shopId","productId","visibility","title","format","storageKey","contentHash","status","error") VALUES
        ${doc(ID.ready, 'READY', null)},
        ${doc(ID.failedPdf, 'FAILED', 'Not a PDF')},
        ${doc(ID.failedEmbed, 'FAILED', 'embedding request failed: 503')},
        ${doc(ID.failedOther, 'FAILED', 'PDF could not be parsed: boom')},
        ${doc(ID.queued, 'QUEUED', null)},
        ${doc(ID.deleted, 'DELETED', null)};
      UPDATE "KnowledgeDocument" SET "embeddingModel" = 'hashing-1024', "chunkCount" = 2 WHERE "id" = '${ID.ready}';
      INSERT INTO "KnowledgeChunk" ("documentId","shopId","visibility","ordinal","headingPath","content","tokens","embedding")
      SELECT '${ID.ready}','${ID.shop}','PUBLIC', n, 'Doc > H' || n, 'text ' || n, 5, array_fill(0.1::real, ARRAY[1024])::vector::halfvec
        FROM generate_series(0, 1) n;
    `);
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    }
    await app?.close();
  });

  it('S47 G51: expand adds the new nullable columns and keeps the old code working', async () => {
    await run(expand, 'up');
    const documents = await columns('KnowledgeDocument');
    for (const column of [
      'failureCode',
      'contentSize',
      'leaseToken',
      'leaseUntil',
      'queuedAt',
      'deletedAt',
      'bytesRemovedAt',
    ])
      expect(documents[column]).toBe(true);
    expect(documents.error).toBe(true); // old code still writes it until the contract step
    expect((await columns('KnowledgeChunk')).embeddingModel).toBe(true);
    const indexes = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeDocument'`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'KnowledgeDocument_shop_list',
        'KnowledgeDocument_platform_list',
        'KnowledgeDocument_sweep',
        'KnowledgeDocument_tombstone',
      ]),
    );
  });

  it('S47 G51: backfill fills the model per passage and the failure codes, and drops nothing', async () => {
    await run(backfill, 'up');
    const chunks = await rows<{ embeddingModel: string }>(
      `SELECT "embeddingModel" FROM "KnowledgeChunk"`,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.embeddingModel === 'hashing-1024')).toBe(true);
    const codes = await rows<{ id: string; failureCode: string | null }>(
      `SELECT "id","failureCode" FROM "KnowledgeDocument"`,
    );
    const byId = Object.fromEntries(codes.map((c) => [c.id, c.failureCode]));
    expect(byId[ID.failedPdf]).toBe('not_a_pdf');
    expect(byId[ID.failedEmbed]).toBe('embedding_unavailable');
    expect(byId[ID.failedOther]).toBe('unparseable');
    expect(byId[ID.ready]).toBeNull();
    const dates = await rows<{
      id: string;
      queuedAt: Date | null;
      deletedAt: Date | null;
    }>(`SELECT "id","queuedAt","deletedAt" FROM "KnowledgeDocument"`);
    expect(dates.find((d) => d.id === ID.queued)?.queuedAt).not.toBeNull();
    expect(dates.find((d) => d.id === ID.deleted)?.deletedAt).not.toBeNull();
    expect((await columns('KnowledgeDocument')).error).toBe(true);
  });

  it('S47 G51: running expand and backfill again changes nothing', async () => {
    const before = await snapshot();
    await run(expand, 'up');
    await run(backfill, 'up');
    expect(await snapshot()).toEqual(before);
  });

  it('S47 G51: contract drops every foreign key to another owner, requires the model per passage and drops the legacy error column', async () => {
    const foreignKeys = () =>
      rows<{ from: string; to: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"KnowledgeDocument"', '"KnowledgeChunk"')`,
      );
    expect(
      (await foreignKeys()).map((k) => `${k.from}->${k.to}`).sort(),
    ).toEqual(
      [
        '"KnowledgeChunk"->"KnowledgeDocument"',
        '"KnowledgeDocument"->"Product"',
        '"KnowledgeDocument"->"Shop"',
      ].sort(),
    ); // the legacy schema, before the contract
    await run(contract, 'up');

    expect((await foreignKeys()).map((k) => `${k.from}->${k.to}`)).toEqual([
      '"KnowledgeChunk"->"KnowledgeDocument"',
    ]); // only the intra-owner key is left
    expect((await columns('KnowledgeDocument')).error).toBeUndefined();
    expect((await columns('KnowledgeChunk')).embeddingModel).toBe(false); // NOT NULL now
    await expect(
      db.query(
        `INSERT INTO "KnowledgeChunk" ("documentId","visibility","ordinal","headingPath","content","tokens","embedding")
         VALUES ('${ID.ready}','PUBLIC',9,'x','y',1, array_fill(0.1::real, ARRAY[1024])::vector::halfvec)`,
      ),
    ).rejects.toThrow(); // a passage without its model is refused
    await run(contract, 'up'); // idempotent: running it again changes nothing
    expect((await foreignKeys()).length).toBe(1);
  });

  it('S47 G51: the failure code and token checks are enforced', async () => {
    await expect(
      db.query(
        `UPDATE "KnowledgeDocument" SET "failureCode" = 'bogus' WHERE "id" = '${ID.ready}'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE "KnowledgeChunk" SET "tokens" = 801`),
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE "KnowledgeChunk" SET "tokens" = 0`),
    ).rejects.toThrow();
  });
});
