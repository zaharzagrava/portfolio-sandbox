import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { networkGuardStats } from '@app/infrastructure/context/transaction-scope';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  assertBooksHealthy,
  balanceOf,
  count,
  journalEvents,
  newShopAccount,
  sql,
  watchNetwork,
} from './testing/ledger-fixtures';
import {
  InsufficientBalance,
  JournalConflict,
  JournalInvalid,
  JournalUnbalanced,
  LedgerBusy,
  TransactionRequired,
} from './domain/ledger-errors';
import { journalId } from './domain/journal';
import type { PostJournalInput } from './application/ledger.service';

const rejected = (reason: string) =>
  MetricsRegistry.value('ledger_post_rejected_total', { reason }) ?? 0;

describe('Ledger: balanced journals, append-only, idempotent postings and limits', () => {
  let t: LedgerTestApp;

  beforeAll(async () => {
    t = await createLedgerApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const input = (
    over: Partial<PostJournalInput> & { lines: PostJournalInput['lines'] },
  ): PostJournalInput => ({
    kind: 'ADJUSTMENT',
    reference: `t-${uuidv4()}`,
    currency: 'EUR',
    ...over,
  });
  const post = (i: PostJournalInput) =>
    t.inTx((tx) => t.ledger.postJournal(i, tx));
  const reasonOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof JournalInvalid) return e.reason;
      if (e instanceof JournalUnbalanced) return 'journal_unbalanced';
      if (e instanceof JournalConflict) return 'journal_conflict';
      if (e instanceof InsufficientBalance) return 'insufficient_balance';
      if (e instanceof LedgerBusy) return 'ledger_busy';
      if (e instanceof TransactionRequired) return 'transaction_required';
      throw e;
    }
    return 'accepted';
  };
  const nothingPersisted = async () => {
    expect(await count(t.app, 'LedgerEntry')).toBe(0);
    expect(await count(t.app, 'LedgerJournal')).toBe(0);
    expect(await count(t.app, 'AccountBalance')).toBe(0);
    expect(
      await count(t.app, 'Outbox', `"type" = 'ledger.journal_posted'`),
    ).toBe(0);
  };

  it('S14 AS-01: an accepted journal has three entries with one postedAt, moves the balances and emits one v2 event', async () => {
    const [a, b, c] = [newShopAccount(), newShopAccount(), newShopAccount()];
    const at = new Date('2026-10-05T10:00:00.123Z');
    t.clock.set(at);
    const result = await post(
      input({
        reference: 't-1',
        lines: [
          { accountId: a, amountMinor: -1000 },
          { accountId: b, amountMinor: 600 },
          { accountId: c, amountMinor: 400 },
        ],
      }),
    );
    expect(result).toEqual({
      journalId: journalId('ADJUSTMENT', 't-1'),
      created: true,
    });

    const entries = await sql<{
      journalId: string;
      createdAt: Date;
      amount: string;
    }>(
      t.app,
      `SELECT "journalId", "createdAt", amount::text FROM "LedgerEntry" ORDER BY amount`,
    );
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.journalId))).toEqual(
      new Set([result.journalId]),
    );
    expect(new Set(entries.map((e) => e.createdAt.getTime()))).toEqual(
      new Set([at.getTime()]),
    );
    expect(entries.reduce((s, e) => s + Number(e.amount), 0)).toBe(0);

    expect(await balanceOf(t.app, a)).toBe(-1000);
    expect(await balanceOf(t.app, b)).toBe(600);
    expect(await balanceOf(t.app, c)).toBe(400);

    const events = await journalEvents(t.app);
    expect(events).toHaveLength(1);
    expect(events[0].version).toBe(2);
    expect(events[0].aggregateId).toBe(result.journalId);
    const byAccount = new Map(
      events[0].payload.lines.map((l) => [l.accountId, l]),
    );
    expect(byAccount.get(a)).toMatchObject({
      shard: 0,
      amountMinor: -1000,
      balanceAfterMinor: -1000,
      balanceVersion: 1,
    });
    expect(byAccount.get(b)).toMatchObject({
      amountMinor: 600,
      balanceAfterMinor: 600,
      balanceVersion: 1,
    });
    expect(events[0].payload).toMatchObject({
      kind: 'ADJUSTMENT',
      currency: 'EUR',
      postedAt: at.toISOString(),
    });
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-02: an unbalanced journal is refused with its sum, counted, and leaves nothing behind', async () => {
    const before = rejected('journal_unbalanced');
    const [a, b, c] = [newShopAccount(), newShopAccount(), newShopAccount()];
    let error: unknown;
    try {
      await post(
        input({
          lines: [
            { accountId: a, amountMinor: -1000 },
            { accountId: b, amountMinor: 600 },
            { accountId: c, amountMinor: 399 },
          ],
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JournalUnbalanced);
    expect((error as JournalUnbalanced).sum).toBe(-1);
    expect(rejected('journal_unbalanced')).toBe(before + 1);
    await nothingPersisted();
  });

  it('S14 AS-03: the store refuses an unbalanced journal at commit, whatever wrote it, and accepts the completed one', async () => {
    const j = uuidv4();
    await expect(
      t.sequelize.transaction(async (transaction) => {
        await t.sequelize.query(
          `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount) VALUES (:j, 'ADJUSTMENT', 'A', 100), (:j, 'ADJUSTMENT', 'B', -99)`,
          { replacements: { j }, transaction },
        );
      }),
    ).rejects.toThrow(/unbalanced ledger journal/);
    expect(await count(t.app, 'LedgerEntry')).toBe(0);

    await t.sequelize.transaction(async (transaction) => {
      await t.sequelize.query(
        `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount) VALUES (:j, 'ADJUSTMENT', 'A', 100), (:j, 'ADJUSTMENT', 'B', -99)`,
        { replacements: { j }, transaction },
      );
      await t.sequelize.query(
        `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount) VALUES (:j, 'ADJUSTMENT', 'C', -1)`,
        { replacements: { j }, transaction },
      );
    });
    expect(await count(t.app, 'LedgerEntry')).toBe(3);
  });

  it.each([
    [
      'one line',
      { lines: [{ accountId: 'PLATFORM_FEES', amountMinor: 5 }] },
      'journal_too_few_lines',
    ],
    [
      'a line of 0',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: 0 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 0 },
        ],
      },
      'line_amount_zero',
    ],
    [
      'a line of 12.5',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -12.5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 12.5 },
        ],
      },
      'line_amount_invalid',
    ],
    [
      'a line of 2^53',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -(2 ** 53) },
          { accountId: 'PAYOUTS_SENT', amountMinor: 2 ** 53 },
        ],
      },
      'line_amount_invalid',
    ],
    [
      '201 lines',
      {
        lines: Array.from({ length: 201 }, (_, i) => ({
          accountId: i === 0 ? 'PLATFORM_FEES' : newShopAccount(),
          amountMinor: i === 0 ? -200 : 1,
        })),
      },
      'journal_too_large',
    ],
    [
      'two currencies in one journal',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5, currency: 'EUR' },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5, currency: 'USD' },
        ],
      },
      'journal_currency_mismatch',
    ],
    [
      'currency eur',
      {
        currency: 'eur',
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5 },
        ],
      },
      'currency_invalid',
    ],
    [
      'currency EURO',
      {
        currency: 'EURO',
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5 },
        ],
      },
      'currency_invalid',
    ],
    [
      'an account SHOP_not-a-uuid',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'SHOP_not-a-uuid', amountMinor: 5 },
        ],
      },
      'account_unknown',
    ],
    [
      'an unknown account FOO',
      {
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'FOO', amountMinor: 5 },
        ],
      },
      'account_unknown',
    ],
    [
      'kind SALE through postJournal',
      {
        kind: 'SALE',
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5 },
        ],
      },
      'kind_not_allowed',
    ],
    [
      'a shard named in a line',
      {
        lines: [
          { accountId: 'PLATFORM_FEES#07', amountMinor: -5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5 },
        ],
      },
      'account_unknown',
    ],
    [
      'an empty reference',
      {
        reference: '',
        lines: [
          { accountId: 'PLATFORM_FEES', amountMinor: -5 },
          { accountId: 'PAYOUTS_SENT', amountMinor: 5 },
        ],
      },
      'reference_invalid',
    ],
  ])(
    'S14 AS-04: %s is refused with its own reason, counted, and persists nothing',
    async (_name, over, reason) => {
      const before = rejected(reason);
      expect(await reasonOf(post(input(over as never)))).toBe(reason);
      expect(rejected(reason)).toBe(before + 1);
      await nothingPersisted();
    },
  );

  it('S14 AS-05: a balance near the safe-integer limit is exact; one that would pass it is refused', async () => {
    const [a, b] = [newShopAccount(), newShopAccount()];
    await post(
      input({
        lines: [
          { accountId: a, amountMinor: -9_007_199_254_740_000 },
          { accountId: b, amountMinor: 9_007_199_254_740_000 },
        ],
      }),
    );
    const got = await t.ledger.getBalances({
      accountIds: [a, b],
      currency: 'EUR',
    });
    expect(got.get(a)?.balanceMinor).toBe(-9_007_199_254_740_000);
    expect(got.get(b)?.balanceMinor).toBe(9_007_199_254_740_000);

    const before = rejected('balance_overflow');
    expect(
      await reasonOf(
        post(
          input({
            lines: [
              {
                accountId: newShopAccount(),
                amountMinor: -9_007_199_254_740_000,
              },
              { accountId: b, amountMinor: 9_007_199_254_740_000 },
            ],
          }),
        ),
      ),
    ).toBe('balance_overflow');
    expect(rejected('balance_overflow')).toBe(before + 1);
    expect(await count(t.app, 'LedgerJournal')).toBe(1);
    expect(await balanceOf(t.app, b)).toBe(9_007_199_254_740_000);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-06: the store rejects UPDATE and DELETE of entries and journal headers, even for a privileged role', async () => {
    const [a, b] = [newShopAccount(), newShopAccount()];
    await post(
      input({
        lines: [
          { accountId: a, amountMinor: -10 },
          { accountId: b, amountMinor: 10 },
        ],
      }),
    );
    for (const statement of [
      `UPDATE "LedgerEntry" SET amount = amount + 1`,
      `DELETE FROM "LedgerEntry"`,
      `UPDATE "LedgerJournal" SET reference = 'x'`,
      `DELETE FROM "LedgerJournal"`,
    ])
      await expect(t.sequelize.query(statement)).rejects.toThrow(/append-only/);
    expect(await count(t.app, 'LedgerEntry')).toBe(2);
    expect(await count(t.app, 'LedgerJournal')).toBe(1);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-07: the same (kind, reference) with identical lines changes nothing; with other lines it is a conflict', async () => {
    const [a, b, c] = [newShopAccount(), newShopAccount(), newShopAccount()];
    const first = input({
      reference: 'once',
      lines: [
        { accountId: a, amountMinor: -1000 },
        { accountId: b, amountMinor: 600 },
        { accountId: c, amountMinor: 400 },
      ],
    });
    const one = await post(first);
    const again = await post({ ...first, lines: [...first.lines].reverse() });
    expect(again).toEqual({ journalId: one.journalId, created: false });
    expect(await count(t.app, 'LedgerEntry')).toBe(3);
    expect(await journalEvents(t.app)).toHaveLength(1);
    expect(await balanceOf(t.app, b)).toBe(600);

    const before = rejected('journal_conflict');
    expect(
      await reasonOf(
        post({
          ...first,
          lines: [
            { accountId: a, amountMinor: -1100 },
            { accountId: b, amountMinor: 700 },
            { accountId: c, amountMinor: 400 },
          ],
        }),
      ),
    ).toBe('journal_conflict');
    expect(rejected('journal_conflict')).toBe(before + 1);
    expect(await count(t.app, 'LedgerEntry')).toBe(3);
    expect(await balanceOf(t.app, b)).toBe(600);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-08: 50 identical postings at once (20 times) give one created, 49 not, one entry set, one event', async () => {
    for (let round = 0; round < 20; round++) {
      const [a, b] = [newShopAccount(), newShopAccount()];
      const same = input({
        reference: `dup-${round}`,
        lines: [
          { accountId: a, amountMinor: -10 },
          { accountId: b, amountMinor: 10 },
        ],
      });
      const results = await Promise.all(
        Array.from({ length: 50 }, () => post(same)),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.journalId)).size).toBe(1);
      expect(await balanceOf(t.app, b)).toBe(10);
    }
    expect(await count(t.app, 'LedgerJournal')).toBe(20);
    expect(await count(t.app, 'LedgerEntry')).toBe(40);
    expect(await journalEvents(t.app)).toHaveLength(20);
    await assertBooksHealthy(t.app);
  }, 120_000);

  it('S14 AS-09: a posting joins the caller transaction: a rollback leaves nothing, no transaction is refused, no network is used', async () => {
    const [a, b] = [newShopAccount(), newShopAccount()];
    const net = watchNetwork(t.app);
    const refusedBefore = networkGuardStats.refused;
    await expect(
      t.inTx(async (tx) => {
        await t.ledger.postJournal(
          input({
            lines: [
              { accountId: a, amountMinor: -10 },
              { accountId: b, amountMinor: 10 },
            ],
          }),
          tx,
        );
        throw new Error('caller changes its mind');
      }),
    ).rejects.toThrow('caller changes its mind');
    await nothingPersisted();

    expect(
      await reasonOf(
        t.ledger.postJournal(
          input({
            lines: [
              { accountId: a, amountMinor: -10 },
              { accountId: b, amountMinor: 10 },
            ],
          }),
          undefined as never,
        ),
      ),
    ).toBe('transaction_required');
    await nothingPersisted();

    await post(
      input({
        lines: [
          { accountId: a, amountMinor: -10 },
          { accountId: b, amountMinor: 10 },
        ],
      }),
    );
    net.stop();
    expect(net.calls()).toEqual([]);
    expect(networkGuardStats.refused).toBe(refusedBefore);
  });

  it('S14 AS-10: two PAYOUT debits of 80 against 100 at once (50 times): one wins, the balance ends at 20 and never goes below 0', async () => {
    let sampledNegative = false;
    let sampling = true;
    const accounts: string[] = [];
    const sampler = (async () => {
      while (sampling) {
        if (accounts.length) {
          const rows = await sql<{ b: string }>(
            t.app,
            `SELECT "balanceMinor"::text AS b FROM "AccountBalance" WHERE "accountId" = ANY(ARRAY[:accounts]::text[])`,
            { accounts },
          );
          if (rows.some((r) => Number(r.b) < 0)) sampledNegative = true;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    for (let round = 0; round < 50; round++) {
      const shop = newShopAccount();
      accounts.push(shop);
      await post(
        input({
          lines: [
            { accountId: 'PAYOUTS_SENT', amountMinor: -100 },
            { accountId: shop, amountMinor: 100 },
          ],
        }),
      );
      const outcomes = await Promise.all(
        [0, 1].map((i) =>
          reasonOf(
            post(
              input({
                kind: 'PAYOUT',
                reference: `payout-${round}-${i}`,
                lines: [
                  { accountId: shop, amountMinor: -80 },
                  { accountId: 'PAYOUT_CLEARING', amountMinor: 80 },
                ],
              }),
            ),
          ),
        ),
      );
      expect(outcomes.sort()).toEqual(['accepted', 'insufficient_balance']);
      expect(await balanceOf(t.app, shop)).toBe(20);
    }
    sampling = false;
    await sampler;
    expect(sampledNegative).toBe(false);

    const shop = newShopAccount();
    await post(
      input({
        lines: [
          { accountId: 'PAYOUTS_SENT', amountMinor: -100 },
          { accountId: shop, amountMinor: 100 },
        ],
      }),
    );
    expect(
      await reasonOf(
        post(
          input({
            kind: 'PAYOUT',
            lines: [
              { accountId: shop, amountMinor: -101 },
              { accountId: 'PAYOUT_CLEARING', amountMinor: 101 },
            ],
          }),
        ),
      ),
    ).toBe('insufficient_balance');
    expect(await balanceOf(t.app, shop)).toBe(100);

    // other kinds may take a seller account below zero
    await post(
      input({
        kind: 'AD_CHARGE',
        lines: [
          { accountId: shop, amountMinor: -1100 },
          { accountId: 'PLATFORM_FEES', amountMinor: 1100 },
        ],
      }),
    );
    expect(await balanceOf(t.app, shop)).toBe(-1000);
    await post(
      input({
        kind: 'ADJUSTMENT',
        lines: [
          { accountId: shop, amountMinor: -5 },
          { accountId: 'PLATFORM_FEES', amountMinor: 5 },
        ],
      }),
    );
    expect(await balanceOf(t.app, shop)).toBe(-1005);

    // PAYOUT_CLEARING is never driven below zero, by any kind
    const clearing = await balanceOf(t.app, 'PAYOUT_CLEARING');
    expect(
      await reasonOf(
        post(
          input({
            kind: 'ADJUSTMENT',
            lines: [
              { accountId: 'PAYOUT_CLEARING', amountMinor: -(clearing + 1) },
              { accountId: 'PAYOUTS_SENT', amountMinor: clearing + 1 },
            ],
          }),
        ),
      ),
    ).toBe('insufficient_balance');
    await assertBooksHealthy(t.app);
  }, 120_000);

  it('S14 AS-26: a posting waits at most about 2 s for a held row, then fails as ledger_busy with nothing written; a repeat succeeds', async () => {
    const [a, b] = [newShopAccount(), newShopAccount()];
    await post(
      input({
        lines: [
          { accountId: a, amountMinor: -10 },
          { accountId: b, amountMinor: 10 },
        ],
      }),
    );
    const before = rejected('ledger_busy');

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.sequelize.transaction(async (transaction) => {
      await t.sequelize.query(
        `SELECT 1 FROM "AccountBalance" WHERE "accountId" = :a FOR UPDATE`,
        { replacements: { a }, transaction },
      );
      locked();
      await hold;
    });
    await lockedPromise;

    const net = watchNetwork(t.app);
    const started = Date.now();
    const reason = await reasonOf(
      post(
        input({
          reference: 'blocked',
          lines: [
            { accountId: a, amountMinor: -5 },
            { accountId: b, amountMinor: 5 },
          ],
        }),
      ),
    );
    const waited = Date.now() - started;
    net.stop();
    expect(reason).toBe('ledger_busy');
    expect(waited).toBeGreaterThanOrEqual(1_800);
    expect(waited).toBeLessThan(4_500);
    expect(net.calls()).toEqual([]);
    expect(rejected('ledger_busy')).toBe(before + 1);
    expect(await count(t.app, 'LedgerJournal', `"reference" = 'blocked'`)).toBe(
      0,
    );

    release();
    await holder;
    const retry = await post(
      input({
        reference: 'blocked',
        lines: [
          { accountId: a, amountMinor: -5 },
          { accountId: b, amountMinor: 5 },
        ],
      }),
    );
    expect(retry.created).toBe(true);
    await assertBooksHealthy(t.app);
  }, 30_000);
});
