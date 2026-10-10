import {
  applyVerification,
  VERIFICATION_STATUSES,
  type VerificationEvent,
  type VerificationStatus,
} from './verification-status';

const EVENTS: VerificationEvent[] = ['submitted', 'verified', 'rejected'];

const LEGAL: Array<
  [VerificationStatus, VerificationEvent, VerificationStatus]
> = [
  ['UNVERIFIED', 'submitted', 'PENDING'],
  ['PENDING', 'verified', 'VERIFIED'],
  ['PENDING', 'rejected', 'REJECTED'],
  ['REJECTED', 'submitted', 'PENDING'],
];

const ALL = VERIFICATION_STATUSES.flatMap((s) =>
  EVENTS.map((e) => [s, e] as const),
);

describe('S03 AS-71 verification machine', () => {
  it.each(ALL)('%s + %s', (from, event) => {
    const legal = LEGAL.find(([f, e]) => f === from && e === event);
    const result = applyVerification(from, event);
    if (legal) expect(result).toEqual({ changed: true, to: legal[2] });
    else expect(result).toEqual({ changed: false });
  });

  it.each(EVENTS)('VERIFIED ignores %s', (event) => {
    expect(applyVerification('VERIFIED', event)).toEqual({ changed: false });
  });
});
