import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ApiConfigService } from '@app/common/config';
import { PayoutTransitionService } from './application/payout-transition.service';
import { TransientPayoutError } from './domain/payout-errors';
import {
  PAYOUT_REPOSITORY,
  type PayoutRepository,
} from './domain/payout-ports';
import { StripePayoutProviderAdapter } from './infra/stripe-payout-provider.adapter';
import {
  assertPayoutBooks,
  createGate,
  createPayoutApp,
  payoutOf,
  payoutRows,
  RUN_AT,
  seedDestination,
  seller,
  shopBalance,
  tally,
  type PayoutRow,
  type PayoutTestApp,
} from './testing';
import { sql } from './testing/ledger-fixtures';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const MIN = 60_000;
const first = { attempt: 1, isLastAttempt: false };

describe('Payouts: provider transfer, idempotency, unknown outcomes and states', () => {
  let t: PayoutTestApp;

  beforeAll(async () => {
    t = await createPayoutApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    t.clock.set(RUN_AT);
  });

  /** A payout created by the real run: `PENDING`, 45 000 of a 50 000 balance by default. */
  const pending = async (balance = 50_000): Promise<PayoutRow> => {
    const s = await seller(t, { balance });
    await t.run.run({});
    return payoutOf(t, s.shopId);
  };
  const row = async (id: string) =>
    (await payoutRows(t, `"id" = :id`, { id }))[0];
  const journals = (id: string) =>
    sql<{ kind: string; reference: string }>(
      t.app,
      `SELECT "kind", "reference" FROM "LedgerJournal" WHERE "reference" LIKE :ref ORDER BY "reference"`,
      { ref: `${id}%` },
    );
  const events = async (type: string, id: string) =>
    sql<{ payload: { payload: Record<string, unknown> } }>(
      t.app,
      `SELECT "payload" FROM "Outbox" WHERE "type" = :type AND "aggregateId" = :id`,
      { type, id },
    );
  const history = async (id: string) =>
    (
      await sql<{ toStatus: string }>(
        t.app,
        `SELECT "toStatus" FROM "PayoutHistory" WHERE "payoutId" = :id ORDER BY "id"`,
        { id },
      )
    ).map((h) => h.toStatus);
  const until = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i += 1) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition not reached');
  };
  /** The first delivery dies after the provider accepted the transfer: its promise never settles. */
  const crashAfterSuccess = async (id: string) => {
    t.provider.next({ kind: 'hang' });
    void t.transfers.send(id, first);
    await until(() => t.provider.transferCalls().length === 1);
  };

  describe('the transition core', () => {
    it('S15 AS-27: a refused (state, event) pair changes nothing; an applied one bumps the version, writes history and its event, and a rollback removes all', async () => {
      const p = await pending();
      const transitions = t.app.get(PayoutTransitionService, { strict: false });

      const refused = await t.inTx((tx) =>
        transitions.apply(p.id, 'provider_success', { actor: 'system' }, tx),
      );
      expect(refused).toEqual({ kind: 'refused', status: 'PENDING' });
      expect(await row(p.id)).toMatchObject({
        status: 'PENDING',
        payoutVersion: 1,
      });

      await expect(
        t.inTx(async (tx) => {
          await transitions.apply(
            p.id,
            'cancel',
            {
              actor: 'admin-1',
              reason: 'test',
              journal: 'reversal',
              event: 'cancelled',
            },
            tx,
          );
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await row(p.id)).toMatchObject({
        status: 'PENDING',
        payoutVersion: 1,
      });
      expect(await history(p.id)).toEqual(['PENDING']);
      expect(await events('payout.cancelled', p.id)).toEqual([]);
      expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);

      const applied = await t.inTx((tx) =>
        transitions.apply(p.id, 'claim', { actor: 'system' }, tx),
      );
      expect(applied).toMatchObject({ kind: 'applied', previous: 'PENDING' });
      expect(await row(p.id)).toMatchObject({
        status: 'SENDING',
        payoutVersion: 2,
      });
      expect(await history(p.id)).toEqual(['PENDING', 'SENDING']);
    });
  });

  describe('the happy path and duplicate delivery', () => {
    it('S15 AS-17: the claim is committed before the provider is called, then PAID with the sent journal, history and event', async () => {
      const p = await pending();
      const gate = createGate();
      t.provider.next({ kind: 'gate', gate });

      const sending = t.transfers.send(p.id, first);
      await gate.reached;
      expect(await row(p.id)).toMatchObject({ status: 'SENDING', attempts: 1 });
      gate.open();
      await sending;

      const done = await row(p.id);
      expect(done).toMatchObject({
        status: 'PAID',
        transferRef: 'tr_fake_1',
        payoutVersion: 3,
      });
      expect(t.provider.transferCalls()).toEqual([
        {
          op: 'transfer',
          payoutId: p.id,
          amountMinor: 45_000,
          currency: 'EUR',
          destination: p.destinationSnapshot,
        },
      ]);
      expect((await journals(p.id)).map((j) => j.reference)).toEqual([
        p.id,
        `${p.id}:sent`,
      ]);
      expect(await history(p.id)).toEqual(['PENDING', 'SENDING', 'PAID']);
      const paid = await events('payout.paid', p.id);
      expect(paid).toHaveLength(1);
      expect(paid[0].payload.payload).toMatchObject({
        payoutId: p.id,
        amountMinor: 45_000,
        transferRef: 'tr_fake_1',
        payoutVersion: 3,
      });
      await assertPayoutBooks(t);
    });

    it('S15 AS-18: ten deliveries at once give one claim, one provider transfer, one PAID, one journal and one event, twenty times over', async () => {
      for (let repetition = 0; repetition < 20; repetition += 1) {
        await t.reset();
        t.clock.set(RUN_AT);
        const p = await pending();

        await Promise.all(
          Array.from({ length: 10 }, () => t.transfers.send(p.id, first)),
        );

        expect(t.provider.transferCalls()).toHaveLength(1);
        expect(t.provider.transfers.size).toBe(1);
        expect(await row(p.id)).toMatchObject({
          status: 'PAID',
          payoutVersion: 3,
        });
        expect((await journals(p.id)).map((j) => j.reference)).toEqual([
          p.id,
          `${p.id}:sent`,
        ]);
        expect(await events('payout.paid', p.id)).toHaveLength(1);
        await assertPayoutBooks(t);
      }
    }, 300_000);

    it('S15 AS-26: the transfer goes to the destination snapshot taken at creation, not to one set afterwards', async () => {
      const s = await seller(t, {
        balance: 50_000,
        destination: 'acct_ORIGINAL1234',
      });
      await t.run.run({});
      await seedDestination(t, s.shopId, 'acct_CHANGEDLATER99');
      const p = await payoutOf(t, s.shopId);

      await t.transfers.send(p.id, first);

      expect(t.provider.transferCalls()[0].destination).toBe(
        'acct_ORIGINAL1234',
      );
      expect(t.provider.transfers.get(p.id)?.destination).toBe(
        'acct_ORIGINAL1234',
      );
    });
  });

  describe('crashes and unknown outcomes', () => {
    it('S15 AS-19: a delivery that died after the provider accepted leaves SENDING; the redelivery reuses the key and gets the same transfer', async () => {
      const p = await pending();
      await crashAfterSuccess(p.id);
      expect(await row(p.id)).toMatchObject({ status: 'SENDING', attempts: 1 });

      await t.transfers.send(p.id, { attempt: 2, isLastAttempt: false });

      expect(await row(p.id)).toMatchObject({
        status: 'PAID',
        transferRef: 'tr_fake_1',
      });
      expect(t.provider.transfers.size).toBe(1);
      expect(t.provider.transferCalls().map((c) => c.payoutId)).toEqual([
        p.id,
        p.id,
      ]);
      await assertPayoutBooks(t);
    });

    it('S15 AS-19: a payout stale in SENDING is settled by the resolver looking the transfer up, without a new transfer', async () => {
      const p = await pending();
      await crashAfterSuccess(p.id);
      t.clock.advance(6 * MIN);

      const summary = await t.resolver.resolveDue(50);

      expect(summary.settled).toBe(1);
      expect(await row(p.id)).toMatchObject({
        status: 'PAID',
        transferRef: 'tr_fake_1',
      });
      expect(t.provider.transferCalls()).toHaveLength(1);
      await assertPayoutBooks(t);
    });

    it('S15 AS-20: a timeout leaves UNKNOWN with no reversal and no new key; the resolver finds the transfer and marks PAID', async () => {
      const p = await pending();
      t.provider.next({ kind: 'timeout', committed: true });

      await t.transfers.send(p.id, first);

      expect(await row(p.id)).toMatchObject({ status: 'UNKNOWN' });
      expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);
      expect(await events('payout.failed', p.id)).toEqual([]);

      await t.resolver.resolveDue(50);

      expect(await row(p.id)).toMatchObject({
        status: 'PAID',
        transferRef: 'tr_fake_1',
      });
      expect(t.provider.transferCalls()).toHaveLength(1);
      await assertPayoutBooks(t);
    });

    it('S15 AS-20: when the provider reports the transfer rejected the resolver marks FAILED and returns the money', async () => {
      const p = await pending();
      t.provider
        .next({ kind: 'timeout' })
        .nextLookups({ kind: 'rejected', code: 'account_closed' });
      await t.transfers.send(p.id, first);

      await t.resolver.resolveDue(50);

      expect(await row(p.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'destination_rejected',
      });
      expect(await shopBalance(t, p.shopId)).toBe(50_000);
      await assertPayoutBooks(t);
    });

    it('S15 AS-21: a transfer the provider does not know is re-sent with the same key; confirmed becomes PAID', async () => {
      const p = await pending();
      t.provider.next({ kind: 'timeout' });
      await t.transfers.send(p.id, first);

      const summary = await t.resolver.resolveDue(50);

      expect(summary.resent).toBe(1);
      expect(await row(p.id)).toMatchObject({ status: 'PAID' });
      expect(t.provider.transferCalls().map((c) => c.payoutId)).toEqual([
        p.id,
        p.id,
      ]);
      expect(t.provider.transfers.size).toBe(1);
    });

    it('S15 AS-21: a re-send the provider rejects becomes FAILED', async () => {
      const p = await pending();
      t.provider.next(
        { kind: 'timeout' },
        { kind: 'reject', code: 'account_closed' },
      );
      await t.transfers.send(p.id, first);

      await t.resolver.resolveDue(50);

      expect(await row(p.id)).toMatchObject({ status: 'FAILED' });
      await assertPayoutBooks(t);
    });

    it('S15 AS-21: after three unanswered re-sends the payout stays UNKNOWN and nothing more is sent', async () => {
      const p = await pending();
      t.provider.next(
        { kind: 'timeout' },
        { kind: 'timeout' },
        { kind: 'timeout' },
        { kind: 'timeout' },
      );
      await t.transfers.send(p.id, first);

      for (let i = 0; i < 6; i += 1) {
        await t.resolver.resolveDue(50);
        t.clock.advance(20 * MIN);
      }

      expect(await row(p.id)).toMatchObject({ status: 'UNKNOWN' });
      expect(t.provider.transferCalls()).toHaveLength(4); // the first send and three re-sends
      expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);
      await assertPayoutBooks(t);
    });

    it('S15 AS-22: an unreachable provider keeps UNKNOWN; after 24 hours exactly one payout.in_doubt is raised and the gauge shows the age', async () => {
      const p = await pending();
      t.provider.next({ kind: 'timeout' });
      await t.transfers.send(p.id, first);
      t.provider.nextLookups(
        ...Array.from({ length: 12 }, () => ({ kind: 'unreachable' as const })),
      );

      const early = await t.resolver.resolveDue(50);
      expect(early.unreachable).toBe(1);
      expect(await row(p.id)).toMatchObject({ status: 'UNKNOWN' });
      expect(await events('payout.in_doubt', p.id)).toEqual([]);

      t.clock.advance(25 * 3_600_000);
      await t.resolver.resolveDue(50);
      t.clock.advance(3_600_000);
      await t.resolver.resolveDue(50);

      expect(await row(p.id)).toMatchObject({ status: 'UNKNOWN' });
      expect(await events('payout.in_doubt', p.id)).toHaveLength(1);
      expect(metric('payout_in_doubt_age_seconds')).toBeGreaterThanOrEqual(
        25 * 3600,
      );
      expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);
    });
  });

  describe('rejections, transient failures and untrusted answers', () => {
    it('S15 AS-23: a definite rejection fails the payout, returns the money, sanitizes the reason and is never retried', async () => {
      const p = await pending();
      t.provider.next({ kind: 'reject', code: 'account_closed' });

      await t.transfers.send(p.id, first);

      const failed = await row(p.id);
      expect(failed).toMatchObject({
        status: 'FAILED',
        failureCode: 'destination_rejected',
      });
      expect(failed.failureReason!.length).toBeLessThanOrEqual(200);
      expect(failed.failureReason).toContain('account_closed');
      expect((await journals(p.id)).map((j) => j.kind)).toEqual([
        'PAYOUT',
        'PAYOUT_REVERSAL',
      ]);
      expect(await history(p.id)).toEqual(['PENDING', 'SENDING', 'FAILED']);
      expect(await events('payout.failed', p.id)).toHaveLength(1);
      expect(await shopBalance(t, p.shopId)).toBe(50_000);
      await assertPayoutBooks(t);

      await t.transfers.send(p.id, { attempt: 2, isLastAttempt: false });
      expect(t.provider.transferCalls()).toHaveLength(1);
    });

    it('S15 AS-23: a rejection that is not about the destination is a provider rejection', async () => {
      const p = await pending();
      t.provider.next({ kind: 'reject', code: 'insufficient_platform_funds' });
      await t.transfers.send(p.id, first);
      expect(await row(p.id)).toMatchObject({
        failureCode: 'provider_rejected',
      });
    });

    it.each(['429', '502', '503', '504', 'reset'] as const)(
      'S15 AS-24: a %s answer is retried with the same key and the next attempt pays',
      async (status) => {
        const p = await pending();
        t.provider.next({ kind: 'transient', status });

        await expect(t.transfers.send(p.id, first)).rejects.toBeInstanceOf(
          TransientPayoutError,
        );
        expect(await row(p.id)).toMatchObject({
          status: 'SENDING',
          attempts: 1,
        });

        await t.transfers.send(p.id, { attempt: 2, isLastAttempt: false });

        expect(await row(p.id)).toMatchObject({ status: 'PAID' });
        expect(t.provider.transferCalls().map((c) => c.payoutId)).toEqual([
          p.id,
          p.id,
        ]);
      },
    );

    it('S15 AS-24: after the last attempt a transient answer leaves UNKNOWN, not FAILED', async () => {
      const p = await pending();
      t.provider.next(
        ...Array.from({ length: 5 }, () => ({
          kind: 'transient' as const,
          status: '503' as const,
        })),
      );
      for (let attempt = 1; attempt <= 4; attempt += 1)
        await expect(
          t.transfers.send(p.id, { attempt, isLastAttempt: false }),
        ).rejects.toBeInstanceOf(TransientPayoutError);

      await t.transfers.send(p.id, { attempt: 5, isLastAttempt: true });

      expect(await row(p.id)).toMatchObject({ status: 'UNKNOWN' });
      expect(t.provider.transferCalls()).toHaveLength(5);
      expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);
    });

    it('S15 AS-24: the adapter classifies one provider error per call and never retries inside', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ statusCode: 429 }, 'transient'],
        [{ statusCode: 502 }, 'transient'],
        [{ statusCode: 503 }, 'transient'],
        [{ statusCode: 504 }, 'transient'],
        [{ code: 'ECONNRESET' }, 'transient'],
        [{ code: 'account_closed', statusCode: 400 }, 'rejected'],
        [{ type: 'StripeConnectionError', message: 'timed out' }, 'unknown'],
        [{ statusCode: 400, code: 'something_new' }, 'unknown'],
      ];
      for (const [error, kind] of cases) {
        const createTransfer = jest.fn().mockRejectedValue(error);
        const adapter = new StripePayoutProviderAdapter(
          { createTransfer } as never,
          { get: () => 10_000 } as unknown as ApiConfigService,
        );
        const outcome = await adapter.transfer({
          payoutId: 'p',
          amountMinor: 1,
          currency: 'EUR',
          destination: 'acct_12345678',
        });
        expect(outcome.kind).toBe(kind);
        expect(createTransfer).toHaveBeenCalledTimes(1);
        expect(createTransfer).toHaveBeenCalledWith(
          expect.objectContaining({ idempotencyKey: 'p', timeoutMs: 10_000 }),
        );
      }
    });

    it.each([
      ['a wrong amount', { kind: 'wrong', field: 'amount' }, 'amount'],
      ['a wrong currency', { kind: 'wrong', field: 'currency' }, 'currency'],
      [
        'a wrong destination',
        { kind: 'wrong', field: 'destination' },
        'destination',
      ],
      [
        'an empty reference',
        { kind: 'wrong', field: 'reference' },
        'missing_transfer',
      ],
      ['a text body', { kind: 'garbage', body: 'ok' }, 'missing_transfer'],
      ['a null body', { kind: 'garbage', body: null }, 'missing_transfer'],
    ] as const)(
      'S15 AS-25: %s is not believed: UNKNOWN, a mismatch count, a discrepancy event, nothing posted',
      async (_label, step, kind) => {
        const p = await pending();
        const before = metric('payout_provider_mismatch_total', { kind });
        t.provider.next(step);

        await t.transfers.send(p.id, first);

        expect(await row(p.id)).toMatchObject({
          status: 'UNKNOWN',
          transferRef: null,
        });
        expect(metric('payout_provider_mismatch_total', { kind })).toBe(
          before + 1,
        );
        const found = await events('payout.discrepancy_detected', p.id);
        expect(found).toHaveLength(1);
        expect(found[0].payload.payload).toMatchObject({ kind });
        expect((await journals(p.id)).map((j) => j.kind)).toEqual(['PAYOUT']);
        await assertPayoutBooks(t);
      },
    );
  });

  describe('late outcomes, no network in a transaction, concurrent settlement', () => {
    it('S15 AS-28: a late rejection after PAID changes nothing, is counted and reported once', async () => {
      const p = await pending();
      await t.transfers.send(p.id, first);
      const paid = await row(p.id);
      const before = metric('payout_conflicting_outcome_total');

      const late = await lateOutcome(p.id, 'reject');
      await lateOutcome(p.id, 'reject');

      expect(late).toBe('unchanged');
      expect(await row(p.id)).toMatchObject({
        status: 'PAID',
        payoutVersion: paid.payoutVersion,
      });
      expect(metric('payout_conflicting_outcome_total')).toBe(before + 2);
      const found = await events('payout.discrepancy_detected', p.id);
      expect(found).toHaveLength(1);
      expect(found[0].payload.payload).toMatchObject({
        kind: 'conflicting_outcome',
      });
      await assertPayoutBooks(t);
    });

    it('S15 AS-28: a late success after FAILED changes nothing, is counted and reported once', async () => {
      const p = await pending();
      t.provider.next({ kind: 'reject', code: 'account_closed' });
      await t.transfers.send(p.id, first);
      const before = metric('payout_conflicting_outcome_total');

      expect(await lateOutcome(p.id, 'success')).toBe('unchanged');

      expect(await row(p.id)).toMatchObject({
        status: 'FAILED',
        transferRef: null,
      });
      expect(metric('payout_conflicting_outcome_total')).toBe(before + 1);
      expect(await events('payout.discrepancy_detected', p.id)).toHaveLength(1);
      expect(await events('payout.paid', p.id)).toEqual([]);
      await assertPayoutBooks(t);
    });

    it('S15 AS-29: while the provider call is blocked no transaction or row lock is held, and the claim is already committed', async () => {
      const p = await pending();
      const gate = createGate();
      t.provider.next({ kind: 'gate', gate });
      const sending = t.transfers.send(p.id, first);
      await gate.reached;

      const read = await row(p.id);
      const update = await Promise.race([
        sql(
          t.app,
          `UPDATE "Payout" SET "failureReason" = 'touched' WHERE "id" = :id RETURNING "id"`,
          { id: p.id },
        ).then(() => 'updated'),
        new Promise((resolve) => setTimeout(() => resolve('waited'), 3_000)),
      ]);
      const idle = await sql<{ n: string }>(
        t.app,
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`,
      );

      expect(read.status).toBe('SENDING');
      expect(update).toBe('updated');
      expect(idle[0].n).toBe('0');
      gate.open();
      await sending;
      expect((await row(p.id)).status).toBe('PAID');
    });

    it('S15 AS-30: the job and the resolver both finishing a stale payout give one PAID, one journal and one event, fifty times over', async () => {
      for (let repetition = 0; repetition < 50; repetition += 1) {
        await t.reset();
        t.clock.set(RUN_AT);
        const p = await pending();
        await crashAfterSuccess(p.id);
        t.clock.advance(6 * MIN);

        await Promise.all([
          t.transfers.send(p.id, { attempt: 2, isLastAttempt: false }),
          t.resolver.resolveDue(50),
        ]);

        expect(await row(p.id)).toMatchObject({ status: 'PAID' });
        expect((await journals(p.id)).map((j) => j.reference)).toEqual([
          p.id,
          `${p.id}:sent`,
        ]);
        expect(await events('payout.paid', p.id)).toHaveLength(1);
        expect(t.provider.transfers.size).toBe(1);
      }
      await assertPayoutBooks(t);
    }, 600_000);
  });

  it('S15 AS-18: the counts of the whole flow stay exact', async () => {
    const p = await pending();
    await t.transfers.send(p.id, first);
    expect(await tally(t)).toEqual({
      payouts: 1,
      journals: 2,
      sendJobs: 1,
      history: 3,
      events: { 'payout.created': 1, 'payout.paid': 1 },
    });
  });

  /** A provider outcome that arrives after another path already finished the payout. */
  async function lateOutcome(id: string, kind: 'reject' | 'success') {
    const record = (await t.app
      .get<PayoutRepository>(PAYOUT_REPOSITORY, { strict: false })
      .findById(id))!;
    const result =
      kind === 'reject'
        ? await t.transfers.reject(record, 'account_closed')
        : await t.transfers.settle(
            record,
            'provider_success',
            t.transfers.paidEffects('tr_late'),
          );
    return result.kind;
  }
});
