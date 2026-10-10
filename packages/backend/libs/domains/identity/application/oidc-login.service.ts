import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  FEDERATED_IDENTITY_REPOSITORY,
  SECOND_FACTOR_REPOSITORY,
  USER_REPOSITORY,
  type FederatedIdentityRecord,
  type FederatedIdentityRepository,
  type SecondFactorRepository,
  type UserRepository,
} from '../domain/ports';
import {
  FederatedIdentityLinked,
  MfaDisabled,
  UserRegistered,
} from '../domain/events';
import type { OidcIdentityClaims } from '../domain/id-token-claims';
import {
  decideLink,
  type EmailMatch,
  type LinkTrust,
} from '../domain/link-decision';
import { OidcCallbackError } from '../domain/oidc-errors';
import { Role } from '../infra/models/user.model';
import { SessionRevocationService } from './session-revocation.service';

/** Thrown inside the transaction to roll it back and run the whole decision again against the committed state. */
class Redecide extends Error {}

const MAX_DECISIONS = 3;

export interface LoginResolution {
  userId: string;
  /** A link whose wipe still has to be confirmed by a session revocation (a crash between commit and revoke). */
  wipeLinkId?: string;
}

/**
 * Who a provider login is, and the writes that follow from it (R-11). Runs after the provider exchange (no network I/O
 * in the transaction) and before the session is issued. A concurrent first login meets a unique index, rolls back,
 * and decides again against what the winner committed, so two parallel callbacks converge on one account.
 */
@Injectable()
export class OidcLoginService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(FEDERATED_IDENTITY_REPOSITORY)
    private readonly identities: FederatedIdentityRepository,
    @Inject(SECOND_FACTOR_REPOSITORY)
    private readonly factors: SecondFactorRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly revocation: SessionRevocationService,
  ) {}

  async complete(input: {
    provider: string;
    trust: LinkTrust;
    identity: OidcIdentityClaims;
  }): Promise<LoginResolution> {
    let resolution: LoginResolution | undefined;
    for (let attempt = 1; attempt <= MAX_DECISIONS; attempt++) {
      try {
        resolution = await this.transactions.run(() => this.decide(input));
        break;
      } catch (error) {
        if (!(error instanceof Redecide) || attempt === MAX_DECISIONS)
          throw error instanceof Redecide
            ? new OidcCallbackError('link_conflict')
            : error;
      }
    }
    const done = resolution!;
    // After the commit: end every session the account had before the link. Until it is confirmed, no session is
    // issued (the link row keeps `wipePending`, so the next sign-in repeats this).
    if (done.wipeLinkId) await this.confirmWipe(done.userId, done.wipeLinkId);
    return done;
  }

  /** Links the provider identity to the signed-in user whatever e-mail the provider reports (FR-065). */
  async linkExplicit(input: {
    userId: string;
    provider: string;
    identity: OidcIdentityClaims;
  }): Promise<void> {
    await this.transactions.run(async () => {
      const owner = await this.identities.findByProviderSubject(
        input.provider,
        input.identity.subject,
      );
      if (owner && owner.userId !== input.userId)
        throw new OidcCallbackError('identity_already_linked');
      if (
        owner ||
        (await this.identities.findByUserProvider(input.userId, input.provider))
      )
        throw new OidcCallbackError('link_conflict');
      const link = await this.identities.insert({
        userId: input.userId,
        provider: input.provider,
        subject: input.identity.subject,
        email: input.identity.email,
        wipePending: false,
      });
      if (!link) throw new OidcCallbackError('link_conflict');
      await this.outbox.append(
        FederatedIdentityLinked.create(input.userId, this.clock.nowMs(), {
          userId: input.userId,
          provider: input.provider,
          linkMethod: 'explicit',
          passwordInvalidated: false,
          mfaReset: false,
        }),
      );
    });
  }

  private async confirmWipe(userId: string, linkId: string): Promise<void> {
    try {
      await this.revocation.revokeAllForUser(userId, 'account_linked');
    } catch {
      throw new OidcCallbackError('oidc_exchange_failed');
    }
    await this.identities.markWipeDone(linkId);
  }

  private async decide(input: {
    provider: string;
    trust: LinkTrust;
    identity: OidcIdentityClaims;
  }): Promise<LoginResolution> {
    const { provider, trust, identity } = input;
    const link = await this.identities.findByProviderSubject(
      provider,
      identity.subject,
    );

    let emailMatch: EmailMatch = 'none';
    let matched: { id: string } | null = null;
    let sameProviderOtherSubject = false;
    if (!link && trust === 'verified-email' && identity.email) {
      const found = await this.users.lookupByEmail(identity.email);
      if (found) {
        matched = found;
        if (found.deleted) emailMatch = 'deleted';
        else {
          const theirs = await this.identities.listForUser(found.id);
          emailMatch = theirs.some((i) => i.provider === 'google')
            ? 'federated'
            : 'plain';
          sameProviderOtherSubject = theirs.some(
            (i) => i.provider === provider && i.subject !== identity.subject,
          );
        }
      }
    }

    const decision = decideLink({
      linkExists: link !== null,
      linkedUserDeleted: link?.userDeleted ?? false,
      trust,
      emailVerified: identity.emailVerified,
      emailMatch,
      sameProviderOtherSubject,
    });

    switch (decision.action) {
      case 'refuse':
        throw new OidcCallbackError(decision.reason);

      case 'login_existing':
        return {
          userId: link!.userId,
          ...(link!.wipePending && { wipeLinkId: link!.id }),
        };

      case 'create_account': {
        const email = trust === 'verified-email' ? identity.email : null;
        const created = await this.users.insertFederated({
          email,
          role: Role.USER,
        });
        if (!created) throw new Redecide();
        await this.insertLink(created.id, provider, identity, false);
        await this.outbox.append([
          UserRegistered.create(created.id, 1, {
            userId: created.id,
            role: Role.USER,
          }),
          this.linked(created.id, provider, 'login', false, false),
        ]);
        return { userId: created.id };
      }

      case 'link_email_wipe': {
        const userId = matched!.id;
        const passwordInvalidated = await this.users.clearPassword(userId);
        const had = await this.factors.deleteAll(userId);
        const mfaReset = had === 'enabled';
        const row = await this.insertLink(userId, provider, identity, true);
        const events: EventEnvelope[] = [
          this.linked(
            userId,
            provider,
            'email_match',
            passwordInvalidated,
            mfaReset,
          ),
        ];
        if (mfaReset)
          events.push(
            MfaDisabled.create(userId, this.clock.nowMs() + 1, {
              userId,
              reason: 'account_linking',
            }),
          );
        await this.outbox.append(events);
        return { userId, wipeLinkId: row.id };
      }

      case 'link_email_plain': {
        const userId = matched!.id;
        await this.insertLink(userId, provider, identity, false);
        await this.outbox.append(
          this.linked(userId, provider, 'email_match', false, false),
        );
        return { userId };
      }
    }
  }

  private async insertLink(
    userId: string,
    provider: string,
    identity: OidcIdentityClaims,
    wipePending: boolean,
  ): Promise<FederatedIdentityRecord> {
    const row = await this.identities.insert({
      userId,
      provider,
      subject: identity.subject,
      email: identity.email,
      wipePending,
    });
    if (!row) throw new Redecide();
    return row;
  }

  private linked(
    userId: string,
    provider: string,
    linkMethod: 'login' | 'email_match' | 'explicit',
    passwordInvalidated: boolean,
    mfaReset: boolean,
  ) {
    return FederatedIdentityLinked.create(userId, this.clock.nowMs(), {
      userId,
      provider,
      linkMethod,
      passwordInvalidated,
      mfaReset,
    });
  }
}
