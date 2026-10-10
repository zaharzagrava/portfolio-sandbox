export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type VerificationEvent = 'submitted' | 'verified' | 'rejected';

export type VerificationMove =
  { changed: true; to: VerificationStatus } | { changed: false };

const TABLE: Record<
  VerificationStatus,
  Partial<Record<VerificationEvent, VerificationStatus>>
> = {
  UNVERIFIED: { submitted: 'PENDING' },
  PENDING: { verified: 'VERIFIED', rejected: 'REJECTED' },
  REJECTED: { submitted: 'PENDING' },
  VERIFIED: {},
};

/** Consumers never fail on an out-of-order event: a pair outside the table is a counted no-op (AS-71). */
export function applyVerification(
  from: VerificationStatus,
  event: VerificationEvent,
): VerificationMove {
  const to = TABLE[from][event];
  return to ? { changed: true, to } : { changed: false };
}
