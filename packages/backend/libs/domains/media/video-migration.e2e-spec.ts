import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { generateTestingModule } from '@app/test/utils/global-modules';

/* eslint-disable @typescript-eslint/no-require-imports -- migrations are plain CommonJS files run by sequelize-cli */
const legacy = require('../../../migrations/20261002120000-videos.js');
const expand = require('../../../migrations/20261013140000-video-s30-expand.js');
const backfill = require('../../../migrations/20261013140100-video-s30-backfill.js');
const contract = require('../../../migrations/20261013140200-video-s30-contract.js');
/* eslint-enable @typescript-eslint/no-require-imports */

interface Migration {
  up(queryInterface: unknown): Promise<void>;
  down(queryInterface: unknown): Promise<void>;
}

const ID = {
  shop: '0192f7a0-0000-7000-8000-00000000a101',
  user: '0192f7a0-0000-7000-8000-00000000b101',
  ready: '0192f7a0-0000-7000-8000-0000000001e1',
  pending: '0192f7a0-0000-7000-8000-0000000001e2',
  failed: '0192f7a0-0000-7000-8000-0000000001e3',
  processing: '0192f7a0-0000-7000-8000-0000000001e5',
  fresh: '0192f7a0-0000-7000-8000-0000000001e4',
};

/**
 * S30 migrations: expand → backfill → contract on a scratch database that starts from the legacy video schema (two FKs to
 * other owners, `error`, `deps`, four statuses), so the backfill sees real legacy rows. The shared test database already
 * has the new schema and is not touched.
 */
describe('Video migration', () => {
  let app: INestApplication;
  let admin: Sequelize;
  let db: Sequelize;
  const name = `s30_mig_${process.pid}_${Date.now() % 100000}`;

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
        character_maximum_length: number | null;
      }>(
        `SELECT column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_name = '${table}'`,
      )
    ).reduce<
      Record<string, { type: string; nullable: boolean; max: number | null }>
    >(
      (all, c) => ({
        ...all,
        [c.column_name]: {
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          max: c.character_maximum_length,
        },
      }),
      {},
    );
  const indexes = async () =>
    (
      await rows<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename IN ('Video','VideoTask','VideoStatusHistory')`,
      )
    ).map((r) => r.indexname);
  const foreignKeys = async () =>
    (
      await rows<{ from: string; to: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
           FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('"Video"', 'Video', '"VideoTask"', 'VideoTask', '"VideoStatusHistory"', 'VideoStatusHistory')`,
      )
    ).map((r) => `${r.from.replace(/"/g, '')}->${r.to.replace(/"/g, '')}`);
  const rejects = async (sql: string) => {
    await expect(db.query(sql)).rejects.toBeDefined();
  };
  const insertFresh = (overrides: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      id: `'${ID.fresh}'`,
      shopId: `'${ID.shop}'`,
      uploaderId: `'${ID.user}'`,
      title: `'t'`,
      visibility: `'public'`,
      status: `'UPLOADING'`,
      sourceKey: `'vsrc/x/source'`,
      sizeBytes: '1024',
      contentType: `'video/mp4'`,
      partSize: '67108864',
      sessionExpiresAt: `now() + interval '1 day'`,
      ...overrides,
    };
    const cols = Object.keys(values)
      .map((c) => `"${c}"`)
      .join(',');
    return `INSERT INTO "Video" (${cols}) VALUES (${Object.values(values).join(',')})`;
  };

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
    await db.query(`
      CREATE TABLE "Shop" ("id" UUID PRIMARY KEY);
      CREATE TABLE "User" ("id" UUID PRIMARY KEY);
    `);
    await run(legacy, 'up');
    await db.query(`
      INSERT INTO "Shop" ("id") VALUES ('${ID.shop}');
      INSERT INTO "User" ("id") VALUES ('${ID.user}');
      INSERT INTO "Video" ("id","shopId","uploaderId","title","visibility","status","sourceKey","error","masterKey","posterKey")
      VALUES
       ('${ID.ready}','${ID.shop}','${ID.user}','${'x'.repeat(250)}','public','READY','videos/${ID.ready}/source',NULL,'videos/${ID.ready}/master.m3u8','videos/${ID.ready}/poster.jpg'),
       ('${ID.pending}','${ID.shop}','${ID.user}','not started','unlisted','UPLOADING','pending',NULL,NULL,NULL),
       ('${ID.failed}','${ID.shop}','${ID.user}','broken','public','FAILED','videos/${ID.failed}/source','transcode:720: Conversion failed!',NULL,NULL),
       ('${ID.processing}','${ID.shop}','${ID.user}','half way','public','PROCESSING','videos/${ID.processing}/source',NULL,NULL,NULL);
      INSERT INTO "VideoTask" ("videoId","name","deps","status","attempts")
      VALUES ('${ID.ready}','probe','{}','DONE',1), ('${ID.ready}','poster','{probe}','DONE',1);
    `);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.close();
    await app?.close();
  });

  it('S30 AS-59: expand adds the new columns, tables and indexes and keeps the old code working', async () => {
    await run(expand, 'up');
    const video = await columns('Video');
    for (const column of [
      'failureCode',
      'internalError',
      'retryCount',
      'sizeBytes',
      'contentType',
      'partSize',
      'sessionExpiresAt',
      'shareToken',
      'productId',
      'outputs',
      'objectsPurgedAt',
      'edgePurgedAt',
      'readyAt',
      'version',
    ])
      expect(video[column]).toBeDefined();
    expect(video.shareToken).toMatchObject({
      type: 'character varying',
      max: 43,
    });
    expect(video.internalError).toMatchObject({ max: 500 });
    expect(video.version.nullable).toBe(false);
    // The old column and the old foreign keys are still there: the legacy code keeps running until the contract step.
    expect(video.error).toBeDefined();
    expect(await foreignKeys()).toEqual(
      expect.arrayContaining(['Video->Shop', 'Video->User']),
    );
    const task = await columns('VideoTask');
    for (const column of [
      'dependsOn',
      'claimedAttempt',
      'leaseExpiresAt',
      'lastSentAt',
      'internalError',
    ])
      expect(task[column]).toBeDefined();
    const history = await columns('VideoStatusHistory');
    expect(history.actorType.nullable).toBe(false);
    const shop = await columns('VideoShopState');
    expect(shop.shopVersion.nullable).toBe(false);
    expect(await indexes()).toEqual(
      expect.arrayContaining([
        'video_shop_created_idx',
        'video_product_ready_idx',
        'video_status_created_idx',
        'video_shop_uploading_idx',
        'video_product_active_idx',
        'video_task_lease_idx',
        'video_task_queued_idx',
        'VideoStatusHistory_video_idx',
      ]),
    );
  });

  it('S30 AS-59: backfill gives legacy rows the new required values, a history row and the new vocabulary', async () => {
    await run(backfill, 'up');
    const [ready] = await rows<Record<string, any>>(
      `SELECT * FROM "Video" WHERE "id" = '${ID.ready}'`,
    );
    expect(ready.title).toHaveLength(200);
    expect(ready.sizeBytes).toBe('1024');
    expect(ready.contentType).toBe('video/mp4');
    expect(ready.partSize).toBe(67108864);
    expect(ready.version).toBe(1);
    // A legacy object lives where it was written: the stored key is kept, not rewritten.
    expect(ready.sourceKey).toBe(`videos/${ID.ready}/source`);
    expect(new Date(ready.sessionExpiresAt).getTime()).toBe(
      new Date(ready.createdAt).getTime() + 24 * 3600_000,
    );
    const [pending] = await rows<Record<string, any>>(
      `SELECT * FROM "Video" WHERE "id" = '${ID.pending}'`,
    );
    expect(pending.sourceKey).toBe(`vsrc/${ID.pending}/source`);
    expect(pending.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [failed] = await rows<Record<string, any>>(
      `SELECT * FROM "Video" WHERE "id" = '${ID.failed}'`,
    );
    expect(failed.internalError).toBe('transcode:720: Conversion failed!');
    expect(failed.failureCode).toBe('transcode_failed');
    const history = await rows<{
      videoId: string;
      toStatus: string;
      actorType: string;
    }>(
      `SELECT "videoId","toStatus","actorType" FROM "VideoStatusHistory" ORDER BY "toStatus"`,
    );
    expect(history.map((h) => h.toStatus)).toEqual([
      'EXPIRED',
      'FAILED',
      'FAILED',
      'PROCESSING',
      'READY',
      'UPLOADING',
    ]);
    expect(new Set(history.map((h) => h.actorType))).toEqual(
      new Set(['system']),
    );
    // Work the old pipeline left open cannot continue: expired / failed, each with its own history row.
    expect(pending.status).toBe('EXPIRED');
    expect(pending.version).toBe(2);
    const [stuck] = await rows<Record<string, any>>(
      `SELECT * FROM "Video" WHERE "id" = '${ID.processing}'`,
    );
    expect(stuck).toMatchObject({
      status: 'FAILED',
      failureCode: 'processing_timeout',
      sourceKey: `videos/${ID.processing}/source`,
    });
    const tasks = await rows<{ name: string; dependsOn: string[] }>(
      `SELECT "name","dependsOn" FROM "VideoTask" ORDER BY "name"`,
    );
    expect(tasks).toEqual([
      { name: 'poster', dependsOn: ['probe'] },
      { name: 'probe', dependsOn: [] },
    ]);
  });

  it('S30 AS-59: backfill is idempotent', async () => {
    await run(backfill, 'up');
    const [{ count }] = await rows<{ count: string }>(
      `SELECT count(*)::text FROM "VideoStatusHistory"`,
    );
    expect(count).toBe('6');
  });

  it('S30 AS-59: contract drops the cross-owner foreign keys and the old columns and sets the NOT NULLs', async () => {
    await run(contract, 'up');
    expect(await foreignKeys()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/->(Shop|User)$/)]),
    );
    const video = await columns('Video');
    expect(video.error).toBeUndefined();
    expect(video.title).toMatchObject({
      type: 'character varying',
      max: 200,
      nullable: false,
    });
    for (const column of [
      'sizeBytes',
      'contentType',
      'partSize',
      'sessionExpiresAt',
    ])
      expect(video[column].nullable).toBe(false);
    expect(video.shareToken.nullable).toBe(true);
    const task = await columns('VideoTask');
    expect(task.deps).toBeUndefined();
    expect(task.dependsOn.nullable).toBe(false);
  });

  it('S30 AS-59: the CHECK constraints hold every data-model bound', async () => {
    await db.query(
      `DELETE FROM "VideoStatusHistory"; DELETE FROM "VideoTask"; DELETE FROM "Video"`,
    );
    await db.query(insertFresh());
    await db.query(`DELETE FROM "Video" WHERE "id" = '${ID.fresh}'`);
    await rejects(insertFresh({ sizeBytes: '1023' }));
    await rejects(insertFresh({ sizeBytes: '21474836481' }));
    await db.query(insertFresh({ sizeBytes: '21474836480' }));
    await db.query(`DELETE FROM "Video" WHERE "id" = '${ID.fresh}'`);
    await rejects(insertFresh({ contentType: `'video/avi'` }));
    await rejects(insertFresh({ status: `'ARCHIVED'` }));
    await rejects(insertFresh({ failureCode: `'weird'` }));
    await rejects(insertFresh({ retryCount: '4' }));
    await rejects(insertFresh({ visibility: `'unlisted'` })); // unlisted needs a share token
    await rejects(insertFresh({ shareToken: `'abc'` })); // a token on a public video
    await rejects(insertFresh({ title: `'${'x'.repeat(201)}'` }));
    await db.query(
      insertFresh({
        visibility: `'unlisted'`,
        shareToken: `'${'a'.repeat(43)}'`,
      }),
    );
    await db.query(`DELETE FROM "Video" WHERE "id" = '${ID.fresh}'`);
    await db.query(insertFresh());
    await rejects(
      `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status","attempts") VALUES ('${ID.fresh}','probe','{}','DONE',4)`,
    );
    await rejects(
      `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status") VALUES ('${ID.fresh}','probe','{}','LOST')`,
    );
    await db.query(
      `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status") VALUES ('${ID.fresh}','probe','{}','CANCELLED')`,
    );
    await rejects(
      `INSERT INTO "VideoTask" ("videoId","name","dependsOn") VALUES ('${ID.fresh}','probe','{}')`,
    ); // (videoId, name) is unique
    await rejects(
      `INSERT INTO "VideoStatusHistory" ("videoId","toStatus","actorType") VALUES ('${ID.fresh}','READY','robot')`,
    );
  });

  it('S30 AS-59: no foreign key leaves the media tables for another owner', async () => {
    expect(
      (await foreignKeys()).filter((k) => !/^(VideoTask->Video)$/.test(k)),
    ).toEqual([]);
  });

  it('S30 AS-59: down restores the nullable legacy shape and the migrations can run again', async () => {
    await run(contract, 'down');
    const video = await columns('Video');
    expect(video.sizeBytes.nullable).toBe(true);
    expect(video.error).toBeDefined();
    await run(expand, 'down');
    expect((await columns('Video')).version).toBeUndefined();
    expect(await columns('VideoShopState')).toEqual({});
    await run(expand, 'up');
    await run(backfill, 'up');
    await run(contract, 'up');
    expect((await columns('Video')).error).toBeUndefined();
  });
});
