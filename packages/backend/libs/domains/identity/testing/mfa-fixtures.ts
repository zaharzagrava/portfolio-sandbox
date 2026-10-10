import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SecretBox } from '../infra/crypto/secret-box';
import { generateRecoveryCodes } from '../domain/recovery-code';
import { generateSecret, stepAt, totpCode } from '../domain/totp';
import { TEST_PASSWORD, type AuthTestApp } from './auth-app';

const sql = (t: AuthTestApp) => t.app.get(Sequelize);

/** An `enabled` second factor written straight into the store (what a finished enrolment leaves behind). */
export async function enableSecondFactor(
  t: AuthTestApp,
  userId: string,
  options: {
    secret?: string;
    /** 0 = sealed without context (a migrated row), 1 = bound to the user. */
    sealVersion?: 0 | 1;
    lastStep?: number | null;
    codes?: string[];
  } = {},
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const box = t.app.get(SecretBox);
  const secret = options.secret ?? generateSecret();
  const sealVersion = options.sealVersion ?? 1;
  const recoveryCodes = options.codes ?? generateRecoveryCodes();
  const now = t.clock.now();
  await sql(t).query(
    `INSERT INTO "SecondFactor"
       ("userId","state","secretSealed","sealVersion","enabledAt","lastStep","createdAt","updatedAt")
     VALUES ($1,'enabled',$2,$3,$4,$5,$4,$4)`,
    {
      bind: [
        userId,
        sealVersion === 1
          ? box.seal(secret, `mfa:${userId}`)
          : box.seal(secret),
        sealVersion,
        now,
        options.lastStep ?? null,
      ],
    },
  );
  for (const code of recoveryCodes)
    await sql(t).query(
      `INSERT INTO "MfaRecoveryCode" ("userId","digest","createdAt") VALUES ($1,$2,$3)`,
      {
        bind: [
          userId,
          box.keyedDigest('mfa-recovery', code.replace('-', '')),
          now,
        ],
      },
    );
  return { secret, recoveryCodes };
}

/** The code an authenticator app shows `offset` steps from now on the test clock. */
export const codeAt = (t: AuthTestApp, secret: string, offset = 0): string =>
  totpCode(secret, stepAt(t.clock.nowMs()) + offset);

export interface SecondFactorView {
  userId: string;
  state: string;
  secretSealed: string;
  sealVersion: number;
  pendingExpiresAt: Date | null;
  enabledAt: Date | null;
  lastStep: string | null;
}

export async function secondFactorRow(
  t: AuthTestApp,
  userId: string,
): Promise<SecondFactorView | undefined> {
  const [row] = await sql(t).query<SecondFactorView>(
    `SELECT * FROM "SecondFactor" WHERE "userId" = $1`,
    { bind: [userId], type: QueryTypes.SELECT },
  );
  return row;
}

export const recoveryRows = (t: AuthTestApp, userId: string) =>
  sql(t).query<{ digest: string; usedAt: Date | null }>(
    `SELECT "digest","usedAt" FROM "MfaRecoveryCode" WHERE "userId" = $1 ORDER BY "id"`,
    { bind: [userId], type: QueryTypes.SELECT },
  );

export const challengeRows = (t: AuthTestApp) =>
  sql(t).query<{
    jti: string;
    userId: string;
    attempts: number;
    spentAt: Date | null;
  }>(`SELECT * FROM "MfaChallengeState"`, { type: QueryTypes.SELECT });

/** Password login; returns the access token (or the challenge token when a factor is enabled). */
export async function passwordLogin(
  t: AuthTestApp,
  email: string,
  password = TEST_PASSWORD,
): Promise<{ accessToken?: string; mfaToken?: string; body: any }> {
  const res = await t
    .http()
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  return {
    accessToken: res.body.accessToken?.token,
    mfaToken: res.body.mfaToken,
    body: res.body,
  };
}

/** The Redis state the specs depend on (rate-limit counters, OIDC flow records) starts empty. */
export async function flushRedis(t: AuthTestApp): Promise<void> {
  await t.app.get(RedisService).client.flushdb();
}
