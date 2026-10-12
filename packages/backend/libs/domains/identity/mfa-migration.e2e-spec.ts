import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import {
  flushRedis,
  passwordLogin,
  secondFactorRow,
  recoveryRows,
} from './testing/mfa-fixtures';
import { generateSecret } from './domain/totp';
import { SecretBox } from './infra/crypto/secret-box';
import { MfaMaintenanceService } from './application/mfa-maintenance.service';

interface Migration {
  up(queryInterface: unknown): Promise<void>;
}
// The migration is a CommonJS file outside the TypeScript sources.
/* eslint-disable @typescript-eslint/no-require-imports */
const migration: Migration = require('../../../migrations/20261010120000-identity-s02-expand.js');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('S02 migration and re-seal drill', () => {
  let t: AuthTestApp;

  beforeAll(async () => {
    t = await createAuthApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
  });

  const db = () => t.app.get(Sequelize);

  it('S02 drill: a legacy enabled factor is copied, still demands a code at login, has no recovery codes, and is re-sealed by the job', async () => {
    const email = 'legacy-mfa@example.com';
    const user = await t.seedUser({ email });
    const plain = generateSecret();
    const legacy = t.app.get(SecretBox).seal(plain);
    await db().query(
      `UPDATE "User" SET "mfaSecretEnc" = $1, "mfaEnabledAt" = now() WHERE "id" = $2`,
      { bind: [legacy, user.id] },
    );
    // A user with a pending (not enabled) legacy enrolment must not be copied.
    const pending = await t.seedUser({ email: 'legacy-pending@example.com' });
    await db().query(`UPDATE "User" SET "mfaSecretEnc" = $1 WHERE "id" = $2`, {
      bind: [legacy, pending.id],
    });

    await migration.up(db().getQueryInterface()); // idempotent: the tables exist already

    const copied = await secondFactorRow(t, user.id);
    expect(copied).toMatchObject({ state: 'enabled', sealVersion: 0 });
    expect(copied!.secretSealed).toBe(legacy);
    expect(await secondFactorRow(t, pending.id)).toBeUndefined();
    expect(await recoveryRows(t, user.id)).toHaveLength(0);
    expect((await passwordLogin(t, email)).mfaToken).toBeDefined();

    expect(
      await t.app.get(MfaMaintenanceService).resealSecrets({ batchSize: 10 }),
    ).toBe(1);

    const sealed = await secondFactorRow(t, user.id);
    expect(sealed!.sealVersion).toBe(1);
    expect(
      t.app.get(SecretBox).open(sealed!.secretSealed, `mfa:${user.id}`),
    ).toBe(plain);
    expect((await passwordLogin(t, email)).mfaToken).toBeDefined();
  });

  it('S02 drill: the migration aborts, naming the pairs and deleting nothing, when an account holds two identities of one provider', async () => {
    const user = await t.seedUser({ email: 'dup-identity@example.com' });
    await db().query(
      `DROP INDEX IF EXISTS "FederatedIdentity_user_provider_uq"`,
    );
    try {
      for (const subject of ['dup-1', 'dup-2'])
        await db().query(
          `INSERT INTO "FederatedIdentity" ("userId","provider","subject","email") VALUES ($1,'google',$2,NULL)`,
          { bind: [user.id, subject] },
        );

      await expect(migration.up(db().getQueryInterface())).rejects.toThrow(
        new RegExp(`\\(${user.id}, google\\) x2`),
      );

      const rows = await db().query(
        `SELECT 1 FROM "FederatedIdentity" WHERE "userId" = $1`,
        { bind: [user.id], type: QueryTypes.SELECT },
      );
      expect(rows).toHaveLength(2);
    } finally {
      await db().query(`DELETE FROM "FederatedIdentity"`);
      await migration.up(db().getQueryInterface());
    }
  });
});
