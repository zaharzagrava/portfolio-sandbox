import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { AppError } from '@app/common/errors/error.types';
import { DatabaseModule } from '@app/infrastructure/database/database.module';
import { RequestContextModule } from './request-context.module';
import { TransactionModule } from './transaction.module';
import { TransactionRunner } from './transaction-runner.service';
import { Transactional } from './transactional.decorator';
import {
  afterCommit,
  assertActiveTransaction,
  getActiveTransaction,
  networkGuardStats,
} from './transaction-scope';
import { safeRequest } from '@app/infrastructure/net';
import { startStandIn, scripted } from '@app/test/toolkit/stand-in-server';
import { ResilientHttpClient } from '@app/infrastructure/http-client';

const TABLE = 'toolkit_tx_probe';

@Injectable()
class WriterA {
  constructor(@InjectConnection() readonly sequelize: Sequelize) {}
  async write(label: string) {
    await this.sequelize.query(`insert into ${TABLE}(label) values ($1)`, {
      bind: [label],
    });
  }
}

@Injectable()
class WriterB {
  constructor(
    @InjectConnection() readonly sequelize: Sequelize,
    private readonly a: WriterA,
  ) {}

  @Transactional()
  async writeBoth(label: string, failAfter = false) {
    await this.a.write(`${label}-a`);
    await this.sequelize.query(`insert into ${TABLE}(label) values ($1)`, {
      bind: [`${label}-b`],
    });
    if (failAfter) throw new Error('boom');
  }
}

@Module({
  imports: [
    DatabaseModule,
    ApiConfigModule,
    RequestContextModule,
    TransactionModule,
  ],
  providers: [WriterA, WriterB],
})
class TxTestModule {}

describe('transactions (TX)', () => {
  let sequelize: Sequelize;
  let runner: TransactionRunner;
  let writerB: WriterB;
  let close: () => Promise<void>;

  const labels = async (prefix: string) =>
    (
      (await sequelize.query(
        `select label from ${TABLE} where label like $1 order by id`,
        { bind: [`${prefix}%`], type: 'SELECT' },
      )) as { label: string }[]
    ).map((r) => r.label);
  const txid = async () =>
    (
      (await sequelize.query('select txid_current() as id', {
        type: 'SELECT',
      })) as { id: string }[]
    )[0].id;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TxTestModule],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    sequelize = moduleRef.get(Sequelize);
    runner = moduleRef.get(TransactionRunner);
    writerB = moduleRef.get(WriterB);
    await sequelize.query(
      `create table if not exists ${TABLE}(id serial primary key, label text not null)`,
    );
    await sequelize.query(
      `create table if not exists ${TABLE}_u(id serial primary key, k text unique)`,
    );
  });
  afterAll(async () => {
    await sequelize.query(`drop table if exists ${TABLE}`);
    await sequelize.query(`drop table if exists ${TABLE}_u`);
    await close();
  });

  it('S54 AS-28: two services compose in one transaction without a transaction argument', async () => {
    await writerB.writeBoth('as28');
    expect(await labels('as28')).toEqual(['as28-a', 'as28-b']);
  });

  it('S54 AS-29: a failure rolls back both writes, the error is unchanged, no afterCommit ran', async () => {
    let ran = false;
    const error = await runner
      .run(async () => {
        afterCommit(() => {
          ran = true;
        });
        await writerB.writeBoth('as29', true);
      })
      .catch((e) => e);
    expect((error as Error).message).toBe('boom');
    expect(await labels('as29')).toEqual([]);
    expect(ran).toBe(false);
  });

  it('S54 AS-30: afterCommit runs once, after commit, in order; a failing callback is isolated', async () => {
    const seen: string[] = [];
    await runner.run(async () => {
      afterCommit(async () => {
        seen.push(`first:${(await labels('as30')).length}`);
      });
      afterCommit(() => {
        throw new Error('callback failure');
      });
      afterCommit(() => {
        seen.push('third');
      });
      await sequelize.query(`insert into ${TABLE}(label) values ('as30')`);
    });
    expect(seen).toEqual(['first:1', 'third']);
  });

  it('S54 AS-31: nested run joins the outer transaction; an inner failure rolls the outer back', async () => {
    await runner.run(async () => {
      const outer = await txid();
      await runner.run(async () => {
        expect(await txid()).toBe(outer);
      });
    });
    await expect(
      runner.run(async () => {
        await sequelize.query(`insert into ${TABLE}(label) values ('as31')`);
        await runner.run(async () => {
          throw new Error('inner');
        });
      }),
    ).rejects.toThrow('inner');
    expect(await labels('as31')).toEqual([]);
  });

  it('S54 AS-32: requires_new commits independently of an outer rollback', async () => {
    await runner
      .run(async () => {
        await sequelize.query(
          `insert into ${TABLE}(label) values ('as32-outer')`,
        );
        await runner.run(
          async () =>
            sequelize.query(
              `insert into ${TABLE}(label) values ('as32-inner')`,
            ),
          { propagation: 'requires_new' },
        );
        throw new Error('outer fails');
      })
      .catch(() => undefined);
    expect(await labels('as32')).toEqual(['as32-inner']);
  });

  it('S54 AS-33: 20 concurrent scopes have 20 distinct transaction ids', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => runner.run(async () => txid())),
    );
    expect(new Set(ids).size).toBe(20);
  });

  it('S54 AS-34: queries after a scope ends run outside any transaction', async () => {
    await runner.run(async () => undefined);
    expect(getActiveTransaction()).toBeUndefined();
    const [a, b] = [await txid(), await txid()];
    expect(a).not.toBe(b); // autocommit: each statement burns its own id
  });

  it('S54 AS-36: retries 40001 up to 3 attempts, never 23505, exhaustion becomes 503 transaction_conflict', async () => {
    let attempts = 0;
    const result = await runner.runSerializable(async () => {
      if (++attempts < 3)
        throw Object.assign(new Error('serialization'), {
          parent: { code: '40001' },
        });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);

    let uniqueAttempts = 0;
    await sequelize.query(`insert into ${TABLE}_u(k) values ('dup')`);
    await expect(
      runner.runSerializable(async () => {
        uniqueAttempts++;
        await sequelize.query(`insert into ${TABLE}_u(k) values ('dup')`);
      }),
    ).rejects.toBeDefined();
    expect(uniqueAttempts).toBe(1);

    const exhausted = await runner
      .runSerializable(async () => {
        throw Object.assign(new Error('deadlock'), {
          parent: { code: '40P01' },
        });
      })
      .catch((e) => e);
    expect(exhausted).toBeInstanceOf(AppError);
    expect(exhausted).toMatchObject({
      status: 503,
      code: 'transaction_conflict',
    });
  });

  it('S54 AS-37: a statement timeout surfaces as 57014 and the lock timeout is applied with a bound value', async () => {
    const timeout = await runner
      .run(async () => sequelize.query('select pg_sleep(1)'), {
        statementTimeoutMs: 50,
      })
      .catch((e) => e);
    expect((timeout as { parent?: { code?: string } }).parent?.code).toBe(
      '57014',
    );
    const shown = await runner.run(
      async () =>
        (
          (await sequelize.query('show lock_timeout', { type: 'SELECT' })) as {
            lock_timeout: string;
          }[]
        )[0].lock_timeout,
      { lockTimeoutMs: 1234 },
    );
    expect(shown).toBe('1234ms');
  });

  it('S54 AS-38: an invalid timeout is rejected before any query runs', async () => {
    await expect(
      runner.run(async () => 1, { lockTimeoutMs: -1 }),
    ).rejects.toThrow(RangeError);
  });

  it('S54 AS-39: assertActiveTransaction throws outside and returns the transaction inside', async () => {
    expect(() => assertActiveTransaction()).toThrow();
    await runner.run(async () => {
      expect(assertActiveTransaction()).toBeDefined();
    });
  });

  it('S54 AS-35: serializable write skew - exactly one removal persists', async () => {
    const ONCALL = `${TABLE}_oncall`;
    await sequelize.query(`drop table if exists ${ONCALL}`);
    await sequelize.query(
      `create table ${ONCALL}(name text primary key, on_call boolean not null)`,
    );
    await sequelize.query(
      `insert into ${ONCALL}(name, on_call) values ('alice', true), ('bob', true)`,
    );
    try {
      // Both scopes read "two people are on call" before either writes: only serializable isolation can see the conflict.
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const goOffCall = (name: string) => {
        let attempt = 0;
        return runner.runSerializable(async () => {
          const [{ n }] = (await sequelize.query(
            `select count(*)::int as n from ${ONCALL} where on_call`,
            { type: 'SELECT' },
          )) as { n: number }[];
          if (++attempt === 1) {
            if (++arrived === 2) open();
            await gate;
          }
          if (n >= 2)
            await sequelize.query(
              `update ${ONCALL} set on_call = false where name = $1`,
              { bind: [name] },
            );
        });
      };
      const settled = await Promise.allSettled([
        goOffCall('alice'),
        goOffCall('bob'),
      ]);
      for (const r of settled) {
        if (r.status === 'rejected')
          expect(r.reason).toMatchObject({
            status: 503,
            code: 'transaction_conflict',
          });
      }
      const remaining = (await sequelize.query(
        `select count(*)::int as n from ${ONCALL} where on_call`,
        { type: 'SELECT' },
      )) as { n: number }[];
      expect(remaining[0].n).toBe(1);
    } finally {
      await sequelize.query(`drop table if exists ${ONCALL}`);
    }
  });

  it('S54 AS-40: safeRequest inside a transaction is refused and counted, and works from afterCommit', async () => {
    const standIn = await startStandIn();
    try {
      const call = () =>
        safeRequest({
          method: 'POST',
          url: `http://127.0.0.1:${standIn.port}/hook`,
          body: '{}',
          timeoutMs: 2_000,
          maxResponseBytes: 1024,
          allowedPorts: [443],
          followRedirects: false,
          allowHttpHosts: ['127.0.0.1'],
          allowPrivateHosts: ['127.0.0.1'],
        });
      const before = networkGuardStats.refused;
      await expect(runner.run(async () => call())).rejects.toThrow(
        /afterCommit/,
      );
      expect(networkGuardStats.refused).toBe(before + 1);
      expect(standIn.requests).toHaveLength(0);

      let status = 0;
      await runner.run(async () => {
        afterCommit(async () => {
          status = (await call()).status;
        });
      });
      expect(status).toBe(200);
      expect(standIn.requests).toHaveLength(1);
    } finally {
      await standIn.close();
    }
  });

  it('S54 AS-40: ResilientHttpClient inside a transaction is refused and counted, and works from afterCommit', async () => {
    const standIn = await startStandIn({
      handler: scripted([
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      ]),
    });
    try {
      const client = ResilientHttpClient.create({ name: 'tx-guard' });
      const call = () =>
        client.requestJson(`http://127.0.0.1:${standIn.port}/hook`, {
          method: 'POST',
          body: '{}',
          timeoutMs: 2_000,
        });
      const before = networkGuardStats.refused;
      await expect(runner.run(async () => call())).rejects.toThrow(
        /afterCommit/,
      );
      expect(networkGuardStats.refused).toBe(before + 1);
      expect(standIn.requests).toHaveLength(0);

      let status = 0;
      await runner.run(async () => {
        afterCommit(async () => {
          status = (await call()).status;
        });
      });
      expect(status).toBe(200);
      expect(standIn.requests).toHaveLength(1);
    } finally {
      await standIn.close();
    }
  });
});
