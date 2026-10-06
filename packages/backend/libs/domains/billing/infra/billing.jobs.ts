import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Op, Sequelize } from 'sequelize';
import Subscription from './models/subscription.model';
import Price from './models/price.model';
import Plan from './models/plan.model';
import Invoice from './models/invoice.model';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { DomainEventsService } from '@app/infrastructure/events/domain-events.service';
import { BillingService } from '../application/billing.service';
import { BillingGateway } from './billing-gateway.port';
import { EntitlementsService } from '../application/entitlements.service';
import { UsageService } from '../application/usage.service';
import { addPeriod } from '../domain/periods';
import { overage } from '../domain/proration';
import { InvoicePaymentFailed, SubscriptionStatusChanged } from '../application/events/billing-events';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'billing.run': Record<string, never>;
  }
}

/** Dunning: retry 1, 3 and 7 days after the first failure, then give up (lesson 10/07 #24). */
export const DUNNING_DAYS = [1, 3, 7];

@Injectable()
export class BillingJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingJobs.name);

  constructor(
    @InjectModel(Subscription) private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Invoice) private readonly invoiceModel: typeof Invoice,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly billing: BillingService,
    private readonly gateway: BillingGateway,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageService,
    private readonly jobs: JobsService,
    private readonly events: DomainEventsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'billing.run', cron: '*/10 * * * *', jobType: 'billing.run', payload: {} });
  }

  /**
   * Renews every due subscription: one transaction each = renewal invoice
   * (plan + overage for the period just ended + late usage from the one
   * before + unapplied credit notes) + period advanced. Idempotent: the
   * invoice is unique per (subscription, periodStart) and the period only
   * advances once. Anchors keep "31st" subscriptions on month ends.
   */
  @JobHandler('billing.run', { concurrency: 1, leaseMs: 600_000 })
  async run(): Promise<number> {
    const due = await this.subscriptionModel.findAll({
      where: { status: { [Op.in]: ['TRIALING', 'ACTIVE'] }, currentPeriodEnd: { [Op.lte]: new Date() } },
      include: [{ model: Price, include: [Plan] }],
      limit: 500,
    });
    for (const subscription of due) await this.renew(subscription).catch((e) => this.logger.error(`renew ${subscription.id}: ${e.message}`));
    return due.length;
  }

  private async renew(subscription: Subscription) {
    if (subscription.cancelAtPeriodEnd) {
      await this.setStatus(subscription, 'CANCELED');
      return;
    }
    const start = subscription.currentPeriodEnd;
    const end = addPeriod(start, subscription.price.interval, subscription.billingAnchorDay);
    const measuredAt = new Date();
    const lines = [
      { kind: 'PLAN', description: subscription.price.plan.name, quantity: subscription.quantity, amount: Number(subscription.price.unitAmount) * (subscription.price.perSeat ? subscription.quantity : 1) },
      ...(await this.usageLines(subscription, measuredAt)),
      ...(await this.creditLines(subscription)),
    ];

    await this.sequelize.transaction(async (transaction) => {
      const [advanced] = await this.subscriptionModel.update(
        { currentPeriodStart: start, currentPeriodEnd: end, status: 'ACTIVE', trialEndsAt: null, version: subscription.version + 1 },
        { where: { id: subscription.id, version: subscription.version }, transaction },
      );
      if (advanced === 0) return; // renewed concurrently
      await this.billing.createInvoice(subscription, 'RENEWAL', start, end, lines, transaction, measuredAt);
      await this.invoiceModel.update({ status: 'PAID' }, { where: { subscriptionId: subscription.id, kind: 'PRORATION', status: 'OPEN', total: { [Op.lt]: 0 } }, transaction });
    });
  }

  /** Overage for the period that just ended, plus late events for the period invoiced before it. */
  private async usageLines(subscription: Subscription, measuredAt: Date) {
    if (subscription.subjectType !== 'SHOP') return [];
    const lines: { kind: string; description: string; quantity: number; amount: number }[] = [];
    const previous = await this.invoiceModel.findOne({ where: { subscriptionId: subscription.id, kind: 'RENEWAL' }, order: [['periodStart', 'DESC']] });

    for (const [metric, included] of Object.entries(subscription.price.includedUsage ?? {})) {
      const per1000 = subscription.price.overagePer1000?.[metric] ?? 0;
      const used = await this.usage.totalFor(subscription.subjectId, metric, subscription.currentPeriodStart, subscription.currentPeriodEnd);
      const o = overage(used, included, per1000);
      if (o.amount > 0) lines.push({ kind: 'USAGE', description: `${metric} over ${included} (${o.units})`, quantity: o.units, amount: o.amount });

      if (previous?.usageMeasuredAt) {
        const late = await this.usage.lateFor(subscription.subjectId, metric, previous.periodStart, previous.periodEnd, previous.usageMeasuredAt);
        // Late units are priced at the overage rate; a closed invoice is never edited (adjustment instead, lesson 06/02 §5).
        if (late > 0) lines.push({ kind: 'ADJUSTMENT', description: `${metric}: ${late} late events from previous period`, quantity: late, amount: Math.ceil(late / 1000) * per1000 });
      }
    }
    return lines;
  }

  private async creditLines(subscription: Subscription) {
    const credits = await this.invoiceModel.findAll({ where: { subscriptionId: subscription.id, kind: 'PRORATION', status: 'OPEN', total: { [Op.lt]: 0 } } });
    return credits.map((c) => ({ kind: 'CREDIT', description: `Credit from plan change on ${c.periodStart.toISOString().slice(0, 10)}`, quantity: 1, amount: Number(c.total) }));
  }

  @JobHandler('billing.charge-invoice', { concurrency: 20 })
  async charge({ invoiceId }: { invoiceId: string }): Promise<void> {
    const invoice = await this.invoiceModel.findByPk(invoiceId);
    if (!invoice || invoice.status !== 'OPEN' || Number(invoice.total) <= 0) return;
    const subscription = await this.subscriptionModel.findByPk(invoice.subscriptionId);
    if (!subscription) return;

    const attempt = invoice.attempts + 1;
    const result = subscription.paymentMethodRef
      ? await this.gateway.charge({ amount: Number(invoice.total), currency: invoice.currency, paymentMethodRef: subscription.paymentMethodRef, idempotencyKey: `${invoice.id}:${attempt}` })
      : ({ ok: false, definite: true, reason: 'no payment method' } as const);

    if (result.ok) {
      await invoice.update({ status: 'PAID', attempts: attempt, nextAttemptAt: null });
      if (subscription.status === 'PAST_DUE') await this.setStatus(subscription, 'ACTIVE');
      return;
    }
    if (!result.definite) throw new Error(`charge outcome unknown: ${result.reason}`); // job retry, same idempotency key

    const nextDays = DUNNING_DAYS[attempt - 1];
    const nextAttemptAt = nextDays !== undefined ? new Date(Date.now() + nextDays * 86_400_000) : null;
    await invoice.update({ attempts: attempt, nextAttemptAt, status: nextAttemptAt ? 'OPEN' : 'UNCOLLECTIBLE' });
    await this.events.record(
      InvoicePaymentFailed.create(invoice.id, attempt, {
        subscriptionId: subscription.id,
        subjectType: subscription.subjectType,
        subjectId: subscription.subjectId,
        attempt,
        nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
      }),
    );

    if (nextAttemptAt) {
      if (subscription.status !== 'PAST_DUE') await this.setStatus(subscription, 'PAST_DUE');
      await this.jobs.enqueue('billing.charge-invoice', { invoiceId }, { runAt: nextAttemptAt, idempotencyKey: `invoice-charge:${invoice.id}:${attempt + 1}` });
    } else {
      await this.setStatus(subscription, 'UNPAID'); // → entitlements fall back to free
    }
  }

  private async setStatus(subscription: Subscription, status: Subscription['status']) {
    await subscription.update({ status, version: subscription.version + 1 });
    await this.entitlements.invalidate(subscription.subjectType, subscription.subjectId);
    await this.events.record(SubscriptionStatusChanged.create(subscription.id, subscription.version, { subjectType: subscription.subjectType, subjectId: subscription.subjectId, status }));
  }
}
