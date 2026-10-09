import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payments.reconcile-daily': { day?: string };
  }
}

declareJobType({
  name: 'payments.reconcile-daily',
  contract: z.object({ day: z.string().optional() }),
});

type IssueKind =
  'MISSING_IN_LEDGER' | 'MISSING_AT_PROVIDER' | 'AMOUNT_MISMATCH';

/**
 * Daily reconciliation (lesson 06/02 §5): what Stripe says we charged vs what
 * our ledger booked, matched by OUR idempotency key. Streams the provider side
 * (constant memory), loads our side for the day, diffs, and records issues for
 * the finance queue. Idempotent per (provider, day) - re-running a finished day
 * is a no-op; re-running a crashed one starts that day over.
 */
@Injectable()
export class ReconciliationJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationJobs.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly stripe: StripeService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'payments.reconcile-daily',
      cron: '30 2 * * *',
      jobType: 'payments.reconcile-daily',
      payload: {},
    });
  }

  @JobHandler('payments.reconcile-daily', { concurrency: 1, leaseMs: 600_000 })
  async reconcile(
    { day }: { day?: string },
    ctx?: { heartbeat(): Promise<void> },
  ): Promise<void> {
    const target =
      day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const from = new Date(`${target}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 86_400_000);

    const [run] = await this.sequelize.query<{
      id: string;
      finishedAt: Date | null;
    }>(
      `INSERT INTO "ReconciliationRun" (provider, day) VALUES ('stripe', :day)
       ON CONFLICT (provider, day) DO UPDATE SET provider = EXCLUDED.provider
       RETURNING id, "finishedAt"`,
      { type: QueryTypes.SELECT, replacements: { day: target } },
    );
    if (run.finishedAt) return;
    await this.sequelize.query(
      `DELETE FROM "ReconciliationIssue" WHERE "runId" = :runId`,
      { replacements: { runId: run.id } },
    );

    const ours = new Map(
      (
        await this.sequelize.query<{ idempotencyKey: string; amount: string }>(
          `SELECT "idempotencyKey", amount FROM "Payment" WHERE status = 'COMPLETED' AND "createdAt" >= :from AND "createdAt" < :to`,
          { type: QueryTypes.SELECT, replacements: { from, to } },
        )
      ).map((p) => [p.idempotencyKey, Number(p.amount)]),
    );

    const issues: { kind: IssueKind; reference: string; details: object }[] =
      [];
    let matched = 0;
    let seen = 0;
    for await (const intent of this.stripe.paymentIntentsCreatedBetween(
      from,
      to,
    )) {
      if (++seen % 1_000 === 0) await ctx?.heartbeat();
      if (intent.status !== 'succeeded') continue;
      const key = intent.metadata?.idempotencyKey;
      if (!key) continue;

      const ourAmount = ours.get(key);
      if (ourAmount === undefined)
        issues.push({
          kind: 'MISSING_IN_LEDGER',
          reference: key,
          details: { intent: intent.id, amount: intent.amount },
        });
      else if (ourAmount !== intent.amount)
        issues.push({
          kind: 'AMOUNT_MISMATCH',
          reference: key,
          details: { ours: ourAmount, provider: intent.amount },
        });
      else matched++;
      ours.delete(key);
    }
    for (const [key, amount] of ours)
      issues.push({
        kind: 'MISSING_AT_PROVIDER',
        reference: key,
        details: { amount },
      });

    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    await this.sequelize.transaction(async (transaction) => {
      for (const issue of issues) {
        await this.sequelize.query(
          `INSERT INTO "ReconciliationIssue" ("runId", kind, reference, details) VALUES (:runId, :kind, :reference, CAST(:details AS JSONB))`,
          {
            replacements: {
              runId: run.id,
              kind: issue.kind,
              reference: issue.reference,
              details: JSON.stringify(issue.details),
            },
            transaction,
          },
        );
      }
      await this.sequelize.query(
        `UPDATE "ReconciliationRun" SET matched = :matched, issues = :issues, "finishedAt" = now() WHERE id = :id`,
        {
          replacements: { matched, issues: issues.length, id: run.id },
          transaction,
        },
      );
    });

    if (issues.length)
      this.logger.warn(
        `reconciliation ${target}: ${issues.length} issues (${matched} matched)`,
      );
  }
}
