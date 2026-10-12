import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  KEY_STORE,
  SIGNING_KEY_REPOSITORY,
  type KeyStorePort,
  type SigningKeyRepository,
} from '../domain/ports';
import {
  decideRotation,
  DEFAULT_ROTATION_CONFIG,
  type RotationAction,
} from '../domain/key-rotation-policy';
import { AuditService } from './audit.service';

/** Another run won the promotion; the transaction is rolled back and the run just looks again. */
class PromotionLost extends Error {}

/** More passes than a fresh environment needs (ACTIVE, NEXT, nothing); a bound against a decision that never settles. */
const MAX_PASSES = 4;

/**
 * Applies `decideRotation` until it has nothing left to do (FR-062). Safe to run concurrently and repeatedly: every
 * write is a conditional change guarded by a store-level uniqueness rule (one ACTIVE, one NEXT), and the loser of a
 * race simply re-reads the keys.
 */
@Injectable()
export class KeyRotationService {
  private readonly logger = new Logger(KeyRotationService.name);

  constructor(
    @Inject(SIGNING_KEY_REPOSITORY)
    private readonly repository: SigningKeyRepository,
    @Inject(KEY_STORE) private readonly keys: KeyStorePort,
    private readonly transactions: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async run(): Promise<void> {
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const actions = decideRotation(
          await this.repository.list(),
          this.clock.now(),
          DEFAULT_ROTATION_CONFIG,
        );
        if (actions.length === 0) return;
        for (const action of actions) await this.apply(action);
      }
    } finally {
      this.keys.invalidate();
    }
  }

  private async apply(action: RotationAction): Promise<void> {
    switch (action.type) {
      case 'create':
        // `null` = the unique index says another instance created it first; the next pass sees it.
        await this.keys.createKey(action.status);
        return;
      case 'promote':
        await this.promote(action.retire, action.activate);
        return;
      case 'purge':
        if (await this.repository.purge(action.kid)) {
          this.logger.log(`purged retired signing key ${action.kid}`);
          this.audit.record('auth.signing_key.purged', { kid: action.kid });
        }
        return;
    }
  }

  private async promote(retire: string, activate: string): Promise<void> {
    const now = this.clock.now();
    try {
      await this.transactions.run(async () => {
        // Retire first: the unique ACTIVE index admits only one ACTIVE row at any moment.
        if (!(await this.repository.retire(retire, now)))
          throw new PromotionLost();
        if (!(await this.repository.activate(activate, now)))
          throw new PromotionLost();
      });
      this.logger.log(`rotated signing key ${retire} → ${activate}`);
      this.audit.record('auth.signing_key.rotated', {
        retired: retire,
        activated: activate,
      });
    } catch (error) {
      if (!(error instanceof PromotionLost)) throw error;
    }
  }
}
