import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  FEDERATED_IDENTITY_REPOSITORY,
  type FederatedIdentityRepository,
} from '../domain/ports';
import {
  Domain_IdentityNotFoundError,
  Domain_LastLoginMethodError,
} from '../domain/errors';
import { FederatedIdentityUnlinked } from '../domain/events';

export interface IdentityView {
  id: string;
  provider: string;
  email: string | null;
  linkedAt: string;
}

/** The signed-in user's own linked sign-in methods. The caller's id is in every predicate (III.4). */
@Injectable()
export class FederatedIdentityService {
  constructor(
    @Inject(FEDERATED_IDENTITY_REPOSITORY)
    private readonly identities: FederatedIdentityRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  async list(userId: string): Promise<IdentityView[]> {
    return (await this.identities.listForUser(userId)).map((i) => ({
      id: i.id,
      provider: i.provider,
      email: i.email,
      linkedAt: new Date(i.createdAt).toISOString(),
    }));
  }

  /** The last way to sign in cannot be removed; another user's, unknown and already deleted ids are all "not found". */
  async unlink(userId: string, identityId: string): Promise<void> {
    await this.transactions.run(async () => {
      const mine = (await this.identities.listForUser(userId)).find(
        (i) => i.id === identityId,
      );
      if (!mine) throw new Domain_IdentityNotFoundError();
      if ((await this.identities.countLoginMethods(userId)) <= 1)
        throw new Domain_LastLoginMethodError();
      const removed = await this.identities.deleteOwned(identityId, userId);
      if (!removed) throw new Domain_IdentityNotFoundError();
      await this.outbox.append(
        FederatedIdentityUnlinked.create(userId, this.clock.nowMs(), {
          userId,
          provider: removed.provider,
        }),
      );
    });
  }
}
