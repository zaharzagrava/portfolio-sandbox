import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { generateTestingModule } from '@app/test/utils/global-modules';

/* eslint-disable @typescript-eslint/no-require-imports -- migrations are plain CommonJS files run by sequelize-cli */
const legacy = require('../../../migrations/20261002090000-media.js');
const expand = require('../../../migrations/20261013130000-media-s29-expand.js');
const backfill = require('../../../migrations/20261013130100-media-s29-backfill.js');
const contract = require('../../../migrations/20261013130200-media-s29-contract.js');
/* eslint-enable @typescript-eslint/no-require-imports */

interface Migration {
  up(queryInterface: unknown): Promise<void>;
  down(queryInterface: unknown): Promise<void>;
}

const ID = {
  shop: '0192f7a0-0000-7000-8000-00000000a001',
  user: '0192f7a0-0000-7000-8000-00000000b001',
  product: '0192f7a0-0000-7000-8000-00000000c001',
  ready: '0192f7a0-0000-7000-8000-0000000000e1',
  decodable: '0192f7a0-0000-7000-8000-0000000000e2',
  other: '0192f7a0-0000-7000-8000-0000000000e3',
  post: '0192f7a0-0000-7000-8000-0000000000e4',
  pending: '0192f7a0-0000-7000-8000-0000000000e5',
};

/**
 * S29 migrations: expand → backfill → contract run on a scratch database that starts from the legacy media schema
 * (three FKs, `rejectReason`, `post` purpose, cascade link table), so the backfill sees real legacy rows. The shared
 * test database already has the new schema and is not touched.
 */
describe('Media S29 migrations (expand, backfill, contract)', () => {
  let app: INestApplication;
  let admin: Sequelize;
  let db: Sequelize;
  const name = `s29_mig_${process.pid}_${Date.now() % 100000}`;

  const rows = <T extends object>(sql: string) =>
    db.query<T>(sql, { type: QueryTypes.SELECT });
  const run = (migration: Migration, direction: 'up' | 'down') =>
    migration[direction](db.getQueryInterface());
  const columns = async (table: string) =>
    (
      await rows<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${table}'`,
      )
    ).reduce<
      Record<string, { type: string; nullable: boolean; def: string | null }>
    >(
      (all, c) => ({
        ...all,
        [c.column_name]: {
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          def: c.column_default,
        },
      }),
      {},
    );
  const foreignKeys = async () =>
    (
      await rows<{ from: string; to: string; del: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to", c.confdeltype AS del
           FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"Media"', '"ProductMedia"', 'Media', 'ProductMedia')`,
      )
    ).map(
      (r) => `${r.from.replace(/"/g, '')}->${r.to.replace(/"/g, '')}:${r.del}`,
    );

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

    // The tables the legacy media schema pointed at (their owners are other domains).
    await db.query(`
      CREATE TABLE "Shop" ("id" UUID PRIMARY KEY);
      CREATE TABLE "User" ("id" UUID PRIMARY KEY);
      CREATE TABLE "Product" ("id" UUID PRIMARY KEY);
    `);
    await run(legacy, 'up');
    await db.query(`
      INSERT INTO "Shop" ("id") VALUES ('${ID.shop}');
      INSERT INTO "User" ("id") VALUES ('${ID.user}');
      INSERT INTO "Product" ("id") VALUES ('${ID.product}');
      INSERT INTO "Media" ("id","shopId","uploaderId","purpose","status","originalKey","variants","width","height","rejectReason")
      VALUES
       ('${ID.ready}','${ID.shop}','${ID.user}','product','READY','media/originals/shops/${ID.shop}/a','{"thumb":{"key":"k","width":1,"height":1}}',10,10,NULL),
       ('${ID.decodable}',NULL,'${ID.user}','review','REJECTED','media/originals/users/${ID.user}/b',NULL,NULL,NULL,'not a decodable image: Input buffer contains unsupported image format'),
       ('${ID.other}',NULL,'${ID.user}','review','REJECTED','media/originals/users/${ID.user}/c',NULL,NULL,NULL,'format gif not allowed'),
       ('${ID.post}',NULL,'${ID.user}','post','READY','media/originals/users/${ID.user}/d',NULL,5,5,NULL),
       ('${ID.pending}',NULL,'${ID.user}','review','PENDING_UPLOAD','media/originals/users/${ID.user}/e',NULL,NULL,NULL,NULL);
      INSERT INTO "ProductMedia" ("productId","mediaId","position") VALUES ('${ID.product}','${ID.ready}',0);
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

  it('S29 E1: expand adds the new columns, tables and indexes and keeps old code working', async () => {
    await run(expand, 'up');
    const media = await columns('Media');
    expect(media.attempts).toMatchObject({
      type: 'integer',
      nullable: false,
      def: '0',
    });
    expect(media.version).toMatchObject({
      type: 'integer',
      nullable: false,
      def: '1',
    });
    expect(media.leaseUntil).toMatchObject({
      type: 'timestamp with time zone',
      nullable: true,
    });
    expect(media.rejectCode).toMatchObject({ type: 'text', nullable: true });
    expect(media.uploadedAt).toMatchObject({
      type: 'timestamp with time zone',
      nullable: true,
    });
    expect(media.duplicateDistance).toMatchObject({
      type: 'smallint',
      nullable: true,
    });
    expect(media.duplicateAt).toMatchObject({
      type: 'timestamp with time zone',
      nullable: true,
    });
    expect(media.rejectReason).toBeDefined(); // old code still writes it until the contract step

    const history = await columns('MediaStatusHistory');
    expect(Object.keys(history).sort()).toEqual(
      [
        'actorId',
        'actorType',
        'createdAt',
        'fromStatus',
        'id',
        'mediaId',
        'rejectCode',
        'toStatus',
      ].sort(),
    );
    expect(history.fromStatus.nullable).toBe(true);
    expect(history.toStatus.nullable).toBe(false);
    const gallery = await columns('ProductGallery');
    expect(Object.keys(gallery).sort()).toEqual([
      'productId',
      'shopId',
      'updatedAt',
      'version',
    ]);
    expect(gallery.version).toMatchObject({
      type: 'integer',
      nullable: false,
      def: '0',
    });

    const indexes = (
      await rows<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename IN ('Media','MediaStatusHistory','ProductMedia','ProductGallery')`,
      )
    ).map((i) => i.indexname);
    for (const expected of [
      'Media_uploader_status_idx',
      'Media_shop_idx',
      'Media_uploaded_idx',
      'Media_lease_idx',
      'Media_terminal_idx',
      'Media_product_b0',
      'Media_product_b1',
      'Media_product_b2',
      'Media_product_b3',
      'MediaStatusHistory_media_idx',
      'ProductGallery_shop_idx',
      'ProductMedia_media_idx',
    ])
      expect(indexes).toContain(expected);
    const unique = await rows<{ condeferrable: boolean; condeferred: boolean }>(
      `SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'ProductMedia_product_position_uq'`,
    );
    expect(unique).toEqual([{ condeferrable: true, condeferred: true }]);

    // new statuses are accepted, old rows are untouched
    await db.query(
      `UPDATE "Media" SET status = 'UPLOADED' WHERE id = '${ID.pending}'`,
    );
    await db.query(
      `UPDATE "Media" SET status = 'PENDING_UPLOAD' WHERE id = '${ID.pending}'`,
    );
  });

  it('S29 E1: backfill maps reject codes, retires post photos, seeds galleries and history; it is idempotent', async () => {
    await run(backfill, 'up');
    await run(backfill, 'up'); // idempotent

    const codes = Object.fromEntries(
      (
        await rows<{ id: string; rejectCode: string | null }>(
          `SELECT id, "rejectCode" FROM "Media" WHERE status = 'REJECTED'`,
        )
      ).map((r) => [r.id, r.rejectCode]),
    );
    expect(codes[ID.decodable]).toBe('not_an_image');
    expect(codes[ID.other]).toBe('processing_failed');

    const post = (
      await rows<{ status: string; version: number }>(
        `SELECT status, version FROM "Media" WHERE id = '${ID.post}'`,
      )
    )[0];
    expect(post.status).toBe('DELETED');
    const postHistory = await rows<{
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
    }>(
      `SELECT "fromStatus","toStatus","actorType" FROM "MediaStatusHistory" WHERE "mediaId" = '${ID.post}' ORDER BY "createdAt", "id"`,
    );
    expect(
      postHistory.map((h) => `${h.fromStatus}>${h.toStatus}:${h.actorType}`),
    ).toEqual(['null>READY:system', 'READY>DELETED:system']);

    // every other photo got exactly one `null → <status>` row, once
    for (const [id, status] of [
      [ID.ready, 'READY'],
      [ID.decodable, 'REJECTED'],
      [ID.other, 'REJECTED'],
      [ID.pending, 'PENDING_UPLOAD'],
    ]) {
      const history = await rows<{
        fromStatus: string | null;
        toStatus: string;
      }>(
        `SELECT "fromStatus","toStatus" FROM "MediaStatusHistory" WHERE "mediaId" = '${id}'`,
      );
      expect(history).toEqual([{ fromStatus: null, toStatus: status }]);
    }

    expect(
      await rows(`SELECT "productId","shopId",version FROM "ProductGallery"`),
    ).toEqual([{ productId: ID.product, shopId: ID.shop, version: 1 }]);

    const checks = await rows<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = '"Media"'::regclass AND contype = 'c'`,
    );
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every((c) => c.convalidated)).toBe(true);
    await expect(
      db.query(
        `INSERT INTO "Media" ("uploaderId","purpose","originalKey") VALUES ('${ID.user}','post','k-post')`,
      ),
    ).rejects.toThrow();
  });

  it('S29 C-3: contract drops the three foreign keys and rejectReason; the link table loses its cascade', async () => {
    expect(await foreignKeys()).toEqual(
      expect.arrayContaining(['Media->Shop:a', 'Media->User:a']),
    );
    await run(contract, 'up');
    const keys = await foreignKeys();
    expect(keys).toEqual(['ProductMedia->Media:a']); // 'a' = no action, i.e. no cascade
    expect((await columns('Media')).rejectReason).toBeUndefined();
    const oldBands = (
      await rows<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('Media_b0','Media_b1','Media_b2','Media_b3')`,
      )
    ).length;
    expect(oldBands).toBe(0);
    // a photo that is linked can no longer be deleted by cascade
    await expect(
      db.query(`DELETE FROM "Media" WHERE id = '${ID.ready}'`),
    ).rejects.toThrow();
  });

  it('S29 E1: down and up again run clean, and the data survives', async () => {
    await run(contract, 'down');
    await run(backfill, 'down');
    await run(expand, 'down');
    expect((await columns('Media')).rejectReason).toBeDefined();
    expect(await columns('MediaStatusHistory')).toEqual({});
    await run(expand, 'up');
    await run(backfill, 'up');
    await run(contract, 'up');
    const rows2 = await rows<{ id: string; status: string }>(
      `SELECT id, status FROM "Media" ORDER BY id`,
    );
    expect(rows2).toHaveLength(5);
    expect(rows2.find((r) => r.id === ID.post)?.status).toBe('DELETED');
    expect((await columns('Media')).rejectReason).toBeUndefined();
    expect((await columns('ProductGallery')).version).toBeDefined();
  });
});
