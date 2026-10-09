import { Test } from '@nestjs/testing';
import { Sequelize } from 'sequelize-typescript';
import { DatabaseModule } from './database.module';
import {
  READ_REPLICA_CONNECTION,
  readReplicaProvider,
} from './read-replica.provider';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { ErrorUtilsService } from '@app/common/errors/error-utils/error-utils.service';

describe('database connection settings (DB)', () => {
  let sequelize: Sequelize;
  let close: () => Promise<void>;
  let moduleRefGet: <T>(token: symbol) => T;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    await moduleRef.init();
    sequelize = moduleRef.get(Sequelize);
    close = () => moduleRef.close();
    moduleRefGet = <T>(token: symbol) => moduleRef.get<T>(token);
  });
  afterAll(async () => {
    await close();
  });

  const show = async (name: string) =>
    (
      (await sequelize.query(`show ${name}`, { type: 'SELECT' })) as Record<
        string,
        string
      >[]
    )[0][name];

  it('S54 AS-145: statement timeout, idle-in-transaction timeout and application name are set on every connection', async () => {
    expect(await show('statement_timeout')).toBe('30s');
    expect(await show('idle_in_transaction_session_timeout')).toBe('30s');
    expect(await show('application_name')).toMatch(/^marketplace/);
  });

  it('S54 AS-145: the pool is bounded and its acquire timeout is short', () => {
    const pool = (
      sequelize.options as { pool?: { acquire?: number; max?: number } }
    ).pool;
    expect(pool?.acquire).toBeLessThanOrEqual(3_000);
    expect(pool?.max).toBe(10);
  });

  it('S54 AS-146: READ_REPLICA_CONNECTION is read-only and capped at 5 connections', async () => {
    const replica = moduleRefGet<Sequelize>(READ_REPLICA_CONNECTION);
    expect(
      (
        (await replica.query('show default_transaction_read_only', {
          type: 'SELECT',
        })) as Record<string, string>[]
      )[0].default_transaction_read_only,
    ).toBe('on');
    await expect(
      replica.query('create temp table replica_write_probe (id int)'),
    ).rejects.toThrow(/read-only/i);
    expect(
      (replica.options as { pool?: { max?: number } }).pool?.max,
    ).toBeLessThanOrEqual(5);
  });

  it('S54 AS-145: with a pool of 2 and 3 long queries the third fails fast as 503 database_unavailable with Retry-After 1', async () => {
    const saved = {
      max: process.env.DB_POOL_MAX,
      acquire: process.env.DB_ACQUIRE_TIMEOUT_MS,
    };
    process.env.DB_POOL_MAX = '2';
    process.env.DB_ACQUIRE_TIMEOUT_MS = '300';
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ErrorUtilsModule],
    }).compile();
    await moduleRef.init();
    try {
      const small = moduleRef.get(Sequelize);
      const started = Date.now();
      const results = await Promise.allSettled(
        [1, 2, 3].map(() => small.query('select pg_sleep(1)')),
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1_500);
      const problem = moduleRef
        .get(ErrorUtilsService)
        .normalizeError(rejected[0].reason);
      expect(problem).toMatchObject({
        status: 503,
        code: 'database_unavailable',
        retryAfterSeconds: 1,
      });
    } finally {
      await moduleRef.close();
      for (const [key, value] of [
        ['DB_POOL_MAX', saved.max],
        ['DB_ACQUIRE_TIMEOUT_MS', saved.acquire],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('S54 AS-146: in production the replica connection always verifies the certificate', () => {
    const base: Record<string, unknown> = {
      db_host: 'db.internal',
      db_port: 5432,
      db_username: 'u',
      db_password: 'p',
      db_name: 'n',
    };
    const configFor = (node_env: string) => ({
      get: (key: string) => ({ ...base, node_env })[key],
    });
    const replica = (
      readReplicaProvider.useFactory as (config: unknown) => Sequelize
    )(configFor('production'));
    expect(
      (replica.options as { dialectOptions?: { ssl?: unknown } }).dialectOptions
        ?.ssl,
    ).toEqual({ require: true, rejectUnauthorized: true });
    const local = (
      readReplicaProvider.useFactory as (config: unknown) => Sequelize
    )(configFor('test'));
    expect(
      (local.options as { dialectOptions?: { ssl?: unknown } }).dialectOptions
        ?.ssl,
    ).toBeUndefined();
  });
});
