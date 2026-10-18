import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { APPLICATIONS, type ApplicationRepository } from '../domain/ports';
import { VerificationPolicyService } from './verification-policy.service';

/** Shops looked at per run; a larger backlog is cleared by the next run. */
const BATCH = 200;

/**
 * The `onboarding.verify-pending` sweep (S04 FR-040, J02 G-09). Verification is decided in the transaction that approves
 * the last document, so a shop is normally verified at once; the sweep is the second line for the shop a crash left with
 * every document approved and the application still `SUBMITTED`. Each shop is its own transaction through the one policy,
 * which re-checks under the application lock: a shop already verified, or still waiting for a document, is left alone, so
 * running the sweep twice emits one `shop.verified` per submission.
 */
@Injectable()
export class VerifyPendingService {
  constructor(
    @Inject(APPLICATIONS) private readonly applications: ApplicationRepository,
    private readonly verification: VerificationPolicyService,
    private readonly transactions: TransactionRunner,
  ) {}

  async run(): Promise<{ examined: number; verified: number }> {
    const shopIds = await this.applications.listPendingVerification(BATCH);
    let verified = 0;
    for (const shopId of shopIds) {
      if (await this.transactions.run(() => this.verification.evaluate(shopId)))
        verified += 1;
    }
    return { examined: shopIds.length, verified };
  }
}
