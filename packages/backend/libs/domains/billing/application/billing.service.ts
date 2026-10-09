import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, UniqueConstraintError } from 'sequelize';
import Subscription from '../infra/models/subscription.model';
import Price from '../infra/models/price.model';
import Invoice from '../infra/models/invoice.model';
import InvoiceLine from '../infra/models/invoice-line.model';
import Plan from '../infra/models/plan.model';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { EntitlementsService } from './entitlements.service';
import { addPeriod } from '../domain/periods';
import { prorate, ProrationLine } from '../domain/proration';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'billing.charge-invoice': { invoiceId: string };
  }
}

const amountFor = (price: Price, quantity: number) =>
  Number(price.unitAmount) * (price.perSeat ? quantity : 1);

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Price) private readonly priceModel: typeof Price,
    @InjectModel(Invoice) private readonly invoiceModel: typeof Invoice,
    @InjectModel(InvoiceLine) private readonly lineModel: typeof InvoiceLine,
    private readonly tx: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  plans() {
    return this.priceModel.findAll({
      where: { active: true },
      include: [Plan],
      order: [['unitAmount', 'ASC']],
    });
  }

  async subscribe(input: {
    subjectType: 'USER' | 'SHOP';
    subjectId: string;
    priceId: string;
    quantity?: number;
    paymentMethodRef?: string;
    trialDays?: number;
  }) {
    const price = await this.priceModel.findByPk(input.priceId, {
      include: [Plan],
    });
    if (!price?.active) throw new NotFoundException('Price not found');
    if ((price.plan.audience === 'SHOP') !== (input.subjectType === 'SHOP'))
      throw new UnprocessableEntityException(
        'Plan not available for this account type',
      );
    const quantity = input.quantity ?? 1;
    const now = new Date();
    const anchorDay = now.getUTCDate();

    try {
      return await this.tx.run(async (transaction) => {
        const trial = (input.trialDays ?? 0) > 0;
        const periodEnd = trial
          ? new Date(now.getTime() + input.trialDays! * 86_400_000)
          : addPeriod(now, price.interval, anchorDay);
        const subscription = await this.subscriptionModel.create(
          {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            priceId: price.id,
            quantity,
            status: trial ? 'TRIALING' : 'ACTIVE',
            billingAnchorDay: anchorDay,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            trialEndsAt: trial ? periodEnd : null,
            paymentMethodRef: input.paymentMethodRef ?? null,
          },
          { transaction },
        );
        if (!trial) {
          await this.createInvoice(
            subscription,
            'RENEWAL',
            now,
            periodEnd,
            [
              {
                kind: 'PLAN',
                description: price.plan.name,
                quantity,
                amount: amountFor(price, quantity),
              },
            ],
            transaction,
          );
        }
        await this.entitlements.invalidate(input.subjectType, input.subjectId);
        return subscription;
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new ConflictException(
          'Already subscribed - change the plan instead',
        );
      throw error;
    }
  }

  /** What a change would cost right now - same function the change itself uses, so preview == invoice. */
  async previewChange(
    subscriptionId: string,
    change: { priceId?: string; quantity?: number },
    at = new Date(),
  ): Promise<ProrationLine[]> {
    const { subscription, oldPrice, newPrice, quantity } =
      await this.loadChange(subscriptionId, change);
    return prorate({
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      changeAt: at,
      oldAmount: amountFor(oldPrice, subscription.quantity),
      newAmount: amountFor(newPrice, quantity),
    });
  }

  async change(
    subscriptionId: string,
    change: { priceId?: string; quantity?: number },
  ) {
    const at = new Date();
    const { subscription, newPrice, quantity } = await this.loadChange(
      subscriptionId,
      change,
    );
    if (subscription.status === 'TRIALING') {
      await subscription.update({
        priceId: newPrice.id,
        quantity,
        version: subscription.version + 1,
      });
      await this.entitlements.invalidate(
        subscription.subjectType,
        subscription.subjectId,
      );
      return { lines: [] };
    }
    const lines = await this.previewChange(subscriptionId, change, at);

    await this.tx.run(async (transaction) => {
      const [updated] = await this.subscriptionModel.update(
        { priceId: newPrice.id, quantity, version: subscription.version + 1 },
        {
          where: { id: subscriptionId, version: subscription.version },
          transaction,
        },
      );
      if (updated === 0)
        throw new ConflictException('Subscription changed concurrently, retry');
      if (lines.length) {
        // Proration invoice keyed by the change time; a net credit stays OPEN with a negative total = credit note for the next renewal.
        await this.createInvoice(
          subscription,
          'PRORATION',
          at,
          subscription.currentPeriodEnd,
          lines.map((l) => ({ ...l, quantity: 1 })),
          transaction,
        );
      }
    });
    await this.entitlements.invalidate(
      subscription.subjectType,
      subscription.subjectId,
    );
    return { lines };
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    const [updated] = await this.subscriptionModel.update(
      { cancelAtPeriodEnd: true },
      { where: { id: subscriptionId, status: { [Op.ne]: 'CANCELED' } } },
    );
    if (!updated) throw new NotFoundException('Subscription not found');
  }

  async forSubject(subjectType: 'USER' | 'SHOP', subjectId: string) {
    return this.subscriptionModel.findOne({
      where: { subjectType, subjectId, status: { [Op.ne]: 'CANCELED' } },
      include: [{ model: Price, include: [Plan] }],
    });
  }

  async invoices(subscriptionId: string) {
    return this.invoiceModel.findAll({
      where: { subscriptionId },
      include: ['lines'],
      order: [['createdAt', 'DESC']],
      limit: 24,
    });
  }

  /** Inserts an invoice + lines; idempotent per (subscription, periodStart, kind). Positive totals get a charge job. */
  async createInvoice(
    subscription: Subscription,
    kind: 'RENEWAL' | 'PRORATION',
    periodStart: Date,
    periodEnd: Date,
    lines: {
      kind: string;
      description: string;
      quantity: number;
      amount: number;
    }[],
    transaction: import('sequelize').Transaction,
    usageMeasuredAt?: Date,
  ): Promise<Invoice | null> {
    const price =
      subscription.price ??
      (await this.priceModel.findByPk(subscription.priceId, { transaction }));
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const [invoice, created] = await this.invoiceModel.findOrCreate({
      where: { subscriptionId: subscription.id, periodStart, kind },
      defaults: {
        subscriptionId: subscription.id,
        periodStart,
        periodEnd,
        kind,
        total,
        currency: price.currency,
        usageMeasuredAt: usageMeasuredAt ?? null,
        status: total <= 0 && kind === 'RENEWAL' ? 'PAID' : 'OPEN',
      },
      transaction,
    });
    if (!created) return null;
    await this.lineModel.bulkCreate(
      lines.map((l) => ({ ...l, invoiceId: invoice.id })),
      { transaction },
    );
    if (total > 0)
      await this.jobs.enqueue(
        'billing.charge-invoice',
        { invoiceId: invoice.id },
        { idempotencyKey: `invoice-charge:${invoice.id}` },
      );
    return invoice;
  }

  private async loadChange(
    subscriptionId: string,
    change: { priceId?: string; quantity?: number },
  ) {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId, {
      include: [Price],
    });
    if (!subscription || subscription.status === 'CANCELED')
      throw new NotFoundException('Subscription not found');
    const newPrice = change.priceId
      ? await this.priceModel.findByPk(change.priceId)
      : subscription.price;
    if (!newPrice?.active) throw new NotFoundException('Price not found');
    if (newPrice.interval !== subscription.price.interval)
      throw new UnprocessableEntityException(
        'Switching billing interval takes effect at renewal',
      );
    return {
      subscription,
      oldPrice: subscription.price,
      newPrice,
      quantity: change.quantity ?? subscription.quantity,
    };
  }
}
