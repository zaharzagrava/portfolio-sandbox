import { Inject, Injectable } from '@nestjs/common';
import { admissionRequired } from '../domain/errors';
import { ADMISSION_TOKEN_PORT, type AdmissionTokenPort } from '../domain/ports';
import { launchMetrics } from '../launch-metrics';

/**
 * The admission check of the hold endpoint (FR-013): signature, pinned algorithm, issuer, audience, subject, purpose and
 * expiry are verified before any store is touched. Every failure is the same `403 ADMISSION_REQUIRED`; the token string
 * is never logged and the reason never leaves this class.
 */
@Injectable()
export class AdmissionService {
  constructor(
    @Inject(ADMISSION_TOKEN_PORT) private readonly tokens: AdmissionTokenPort,
  ) {}

  async assertAdmitted(
    token: string | undefined,
    eventId: string,
    userId: string,
  ): Promise<void> {
    try {
      if (!token) throw new Error('missing');
      await this.tokens.verify(token, { eventId, userId });
    } catch {
      launchMetrics.holds.add(1, { outcome: 'admission_refused' });
      throw admissionRequired();
    }
  }
}
