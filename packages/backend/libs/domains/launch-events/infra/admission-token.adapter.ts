import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { PurposeTokenService } from '@app/domains/identity';
import { ADMISSION_TTL_SEC } from '../domain/constants';
import type { AdmissionTokenPort } from '../domain/ports';

const PURPOSE = 'admission';
export const admissionAudience = (eventId: string) => `admission:${eventId}`;

/**
 * Admission tokens through identity's `PurposeTokenService` (S01 R1; G-03): ES256, `iss: marketplace`,
 * `aud: admission:<eventId>`, `sub` = buyer, `jti` = ticket, purpose `admission`, exactly 10 minutes. The token is
 * refused as an access token and vice versa (its own `typ`).
 */
@Injectable()
export class PurposeAdmissionTokens implements AdmissionTokenPort {
  constructor(
    private readonly tokens: PurposeTokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issue(input: {
    eventId: string;
    userId: string;
    ticket: string;
  }): Promise<{ token: string; expiresAtMs: number }> {
    const token = await this.tokens.sign({
      subject: input.userId,
      audience: admissionAudience(input.eventId),
      ttlSec: ADMISSION_TTL_SEC,
      jti: input.ticket,
      claims: { purpose: PURPOSE, eventId: input.eventId },
    });
    const issued = Math.floor(this.clock.nowMs() / 1000);
    return { token, expiresAtMs: (issued + ADMISSION_TTL_SEC) * 1000 };
  }

  async verify(
    token: string,
    expected: { eventId: string; userId: string },
  ): Promise<void> {
    const claims = await this.tokens.verify(token, {
      audience: admissionAudience(expected.eventId),
      subject: expected.userId,
    });
    if (claims.claims.purpose !== PURPOSE) throw new Error('purpose');
  }
}
