import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  BREACH_CHECKER,
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type BreachCheckerPort,
  type PasswordHasherPort,
  type UserRepository,
} from '../domain/ports';
import { Domain_WeakPasswordError } from '../domain/errors';
import {
  RegistrationDuplicateAttempted,
  UserRegistered,
} from '../domain/events';
import { normalizeEmail, passwordProblem } from '../domain/password-policy';
import { Role } from '../infra/models/user.model';
import { AuditService } from './audit.service';

/**
 * Registration that answers the same way for a new and a taken address (FR-001, V.4). Exactly one password hash is
 * computed on both paths (FR-007), the user row and the event commit together (FR-003), and no network call happens
 * inside the transaction (III.3): the breach lookup comes first.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(BREACH_CHECKER) private readonly breach: BreachCheckerPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    role?: Role;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
    const problem = passwordProblem(input.password, email);
    if (problem) throw new Domain_WeakPasswordError(problem);
    if (await this.isBreached(input.password))
      throw new Domain_WeakPasswordError('breached');

    const passwordHash = await this.hasher.hash(input.password);
    const role = input.role ?? Role.USER;

    await this.transactions.run(async () => {
      const { id, created } = await this.users.insertIfAbsent({
        email,
        passwordHash,
        role,
      });
      await this.outbox.append(
        created
          ? UserRegistered.create(id, 1, { userId: id, role })
          : RegistrationDuplicateAttempted.create(id, this.clock.nowMs(), {
              userId: id,
            }),
      );
    });
  }

  /** Fails open: an unreachable or slow corpus never blocks registration, it is counted (FR-006). */
  private async isBreached(password: string): Promise<boolean> {
    try {
      return await this.breach.isBreached(password);
    } catch {
      this.audit.breachCheckSkipped();
      return false;
    }
  }
}
