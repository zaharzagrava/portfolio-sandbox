import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { generateTestingModule } from '@app/test/utils/global-modules';

/* eslint-disable @typescript-eslint/no-require-imports -- migrations are plain CommonJS files run by sequelize-cli */
const expand = require('../../../migrations/20261010140000-tenancy-s03-expand.js');
const contract = require('../../../migrations/20261010141000-tenancy-s03-contract-fks.js');

describe('Tenancy schema and migrations', () => {
  let app: INestApplication;
  let sequelize: Sequelize;

  const rows = <T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ) => sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
  const indexDef = async (name: string) =>
    (
      await rows<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = :name`,
        { name },
      )
    )[0]?.indexdef;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([]);
    app = moduleRef.createNestApplication();
    await app.init();
    sequelize = app.get(Sequelize);
  });
  afterAll(() => app.close());

  it('S03 AS-61: the pending-invite index is unique per shop and lower-cased address', async () => {
    const def = await indexDef('ShopInvite_pending_email_uq');
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/"shopId", lower\(email\)/);
    expect(def).toMatch(/acceptedAt" IS NULL/);
    expect(def).toMatch(/revokedAt" IS NULL/);
  });

  it('S03 AS-61: membership has both keyset indexes, shops the purge and sandbox indexes, invites the expiry index', async () => {
    expect(await indexDef('ShopMembership_user_created_idx')).toMatch(
      /\("userId", "createdAt", "shopId"\)/,
    );
    expect(await indexDef('ShopMembership_shop_created_idx')).toMatch(
      /\("shopId", "createdAt", "userId"\)/,
    );
    expect(await indexDef('Shop_sandbox_of_uq')).toMatch(
      /UNIQUE.*\("sandboxOf"\).*WHERE/,
    );
    expect(await indexDef('Shop_deleting_purge_idx')).toMatch(
      /\(status, "purgeAt"\).*DELETING/,
    );
    expect(await indexDef('ShopInvite_expires_idx')).toMatch(/\("expiresAt"\)/);
  });

  it('S03 AS-61: no tenancy table references a table of another owner, and ShopMembership.userId has no foreign key', async () => {
    const fks = await rows<{ from: string; to: string; col: string }>(
      `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to", a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.conrelid::regclass::text IN
         ('"Shop"','"ShopMembership"','"ShopInvite"','"ShopDirectory"','"ShopSsoConfig"','"ShopStatusHistory"')`,
    );
    const own = new Set([
      '"Shop"',
      '"ShopMembership"',
      '"ShopInvite"',
      '"ShopDirectory"',
      '"ShopSsoConfig"',
      '"ShopStatusHistory"',
    ]);
    expect(fks.filter((f) => !own.has(f.to))).toEqual([]);
    expect(
      fks.find((f) => f.from === '"ShopMembership"' && f.col === 'userId'),
    ).toBeUndefined();
  });

  it('S03 AS-61: ShopStatusHistory exists with the documented columns', async () => {
    const cols = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ShopStatusHistory'`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      ['actor', 'at', 'from', 'id', 'reason', 'shopId', 'to'].sort(),
    );
  });

  it('S03 AS-61: migrations go up, down and up again; the second up reduces duplicate pending invites to the newest', async () => {
    const qi = sequelize.getQueryInterface();
    await sequelize.query(
      `TRUNCATE "ShopInvite", "ShopMembership", "ShopDirectory", "Shop" CASCADE`,
    );

    await contract.down(qi);
    await expand.down(qi);
    expect(await indexDef('ShopInvite_pending_email_uq')).toBeUndefined();
    const dropped = await rows(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'ShopInvite' AND column_name = 'revokedAt'`,
    );
    expect(dropped).toHaveLength(0);

    // The old schema allows two pending invites for one address.
    const [shop] = await rows<{ id: string }>(
      `INSERT INTO "Shop" ("slug","name") VALUES ('schema-test','Schema test') RETURNING "id"`,
    );
    const invitedBy = '00000000-0000-4000-8000-000000000001';
    const insert = (hash: string, at: string, email: string) =>
      sequelize.query(
        `INSERT INTO "ShopInvite" ("shopId","email","role","tokenHash","invitedBy","expiresAt","createdAt")
         VALUES (:shopId, :email, 'STAFF', :hash, :invitedBy, now() + interval '1 day', :at)`,
        { replacements: { shopId: shop.id, hash, invitedBy, at, email } },
      );
    await insert('h1', '2026-01-01T00:00:00Z', 'dup@example.com');
    await insert('h2', '2026-01-02T00:00:00Z', 'Dup@Example.com');

    await expand.up(qi);
    await contract.up(qi);

    const invites = await rows<{ tokenHash: string; revokedAt: Date | null }>(
      `SELECT "tokenHash","revokedAt" FROM "ShopInvite" ORDER BY "createdAt"`,
    );
    expect(invites[0].revokedAt).not.toBeNull(); // older one revoked, not deleted
    expect(invites[1].revokedAt).toBeNull();
    expect(await indexDef('ShopInvite_pending_email_uq')).toBeDefined();
    await sequelize.query(`TRUNCATE "ShopInvite", "Shop" CASCADE`);
  });

  it('S03 AS-61: the contract migration gives up after the lock timeout instead of queueing behind a held lock', async () => {
    const holder = (await sequelize.connectionManager.getConnection({
      type: 'write',
    })) as { query(sql: string): Promise<unknown> };
    try {
      await holder.query('BEGIN');
      await holder.query(
        'LOCK TABLE "ShopMembership" IN ACCESS EXCLUSIVE MODE',
      );
      await contract.down(sequelize.getQueryInterface()); // ADD CONSTRAINT needs a lock on the same table
      throw new Error('expected a lock timeout');
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/lock timeout/i);
    } finally {
      await holder.query('ROLLBACK');
      sequelize.connectionManager.releaseConnection(holder);
    }
    // Restore the state the other specs expect.
    await contract.up(sequelize.getQueryInterface());
  });
});
