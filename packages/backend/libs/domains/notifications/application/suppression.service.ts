import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { Channel } from '../domain/catalog';
import { suppressedCounter } from '../domain/metrics';
import {
  SUPPRESSION_REPOSITORY,
  type SuppressionRepository,
} from '../domain/ports';
import type { SuppressionReason } from '../domain/types';

/**
 * Addresses we must never contact again (hard bounce, spam complaint, carrier STOP, dead push token), per channel and
 * normalized address (FR-042). Every check reads the repository: a suppression is in effect for the very next send, and
 * mandatory notices obey it too. Sending to known-bad addresses is how a sender's reputation gets suspended.
 */
@Injectable()
export class SuppressionService {
  constructor(
    @Inject(SUPPRESSION_REPOSITORY)
    private readonly repository: SuppressionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** E-mail: trimmed and lower-cased; phone: E.164 digits only (no spaces, dashes or brackets); push tokens are opaque. */
  normalize(channel: Channel, address: string): string {
    if (channel === 'email') return address.trim().toLowerCase();
    if (channel === 'sms') return address.replace(/[^\d+]/g, '');
    return address;
  }

  async isSuppressed(channel: Channel, address: string): Promise<boolean> {
    const normalized = this.normalize(channel, address);
    return (await this.repository.suppressedAmong(channel, [normalized])).has(
      normalized,
    );
  }

  /** Idempotent: suppressing an address twice stores one row. */
  async suppress(
    channel: Channel,
    addresses: string[],
    reason: SuppressionReason,
  ): Promise<void> {
    const now = this.clock.now();
    for (const address of new Set(
      addresses.map((a) => this.normalize(channel, a)),
    ))
      if (await this.repository.add(channel, address, reason, now))
        suppressedCounter.add(1, { channel, reason });
  }
}
