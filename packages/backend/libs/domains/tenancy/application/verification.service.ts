import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  SHOP_REPOSITORY,
  TENANT_TRANSACTIONS,
  type ShopRepository,
  type TenantTransactions,
} from '../domain/ports';
import { ShopVerificationChanged } from '../domain/events';
import { provisionedCounter } from '../domain/tenancy-metrics';
import {
  applyVerification,
  type VerificationEvent,
  type VerificationStatus,
} from '../domain/verification-status';

export type VerificationOutcome = 'changed' | 'unchanged' | 'ignored';

/**
 * Verification status and the payouts flag follow seller onboarding's events through the machine of AS-71 (FR-008).
 * `payoutsEnabled` is true only while `VERIFIED`, which is final. A shop that is unknown or tombstoned is ignored and
 * counted. Events are not guaranteed to arrive in order: a decision that reaches a shop still `UNVERIFIED` first
 * passes through the submission it implies, so the late `submitted` finds the shop already decided and changes nothing.
 */
@Injectable()
export class VerificationService {
  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {}

  async apply(
    shopId: string,
    event: VerificationEvent,
  ): Promise<VerificationOutcome> {
    return this.shopTx.inShop(shopId, async () => {
      const shop = await this.shops.lockById(shopId);
      if (!shop || shop.status === 'DELETED') {
        provisionedCounter.add(1, { outcome: 'verification_ignored' });
        return 'ignored';
      }
      let status: VerificationStatus = shop.verificationStatus;
      if (status === 'UNVERIFIED' && event !== 'submitted') {
        const implied = applyVerification(status, 'submitted');
        if (implied.changed) status = implied.to;
      }
      const move = applyVerification(status, event);
      if (!move.changed) {
        provisionedCounter.add(1, { outcome: 'verification_ignored' });
        return 'unchanged';
      }
      const updated = await this.shops.setVerification(
        shopId,
        move.to,
        move.to === 'VERIFIED',
        this.clock.now(),
      );
      if (!updated) return 'ignored';
      await this.outbox.append(
        ShopVerificationChanged.create(shopId, updated.shopVersion, {
          shopId,
          verificationStatus: updated.verificationStatus,
          payoutsEnabled: updated.payoutsEnabled,
          shopVersion: updated.shopVersion,
        }),
      );
      return 'changed';
    });
  }
}
