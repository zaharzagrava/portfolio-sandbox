import type { INestApplication } from '@nestjs/common';
import { VerificationService } from '../application/verification.service';
import type { VerificationEvent } from '../domain/verification-status';

const KINDS: Record<string, VerificationEvent> = {
  'shop.onboarding_submitted': 'submitted',
  'shop.verified': 'verified',
  'shop.rejected': 'rejected',
};

/**
 * Test-only stand-in for tenancy's worker consumer of seller onboarding's `shop.*` events (S03 AS-72): applies, in
 * order, the verification events among the given outbox rows to their shop. Rows of other types are skipped.
 */
export async function followVerificationEvents(
  app: INestApplication,
  rows: Array<{ type: string | null; aggregateId: string }>,
): Promise<void> {
  const verification = app.get(VerificationService, { strict: false });
  for (const row of rows) {
    const kind = row.type ? KINDS[row.type] : undefined;
    if (kind) await verification.apply(row.aggregateId, kind);
  }
}
