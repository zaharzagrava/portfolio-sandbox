import {
  POSITION_MAX_AGE_MS,
  isEligible,
  type EligibilityFacts,
} from './courier-eligibility';

const NOW = 1_800_000_000_000;

const courier = (patch: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  courierId: 'c1',
  status: 'AVAILABLE',
  positionTs: NOW - 1_000,
  hasLiveOffer: false,
  ...patch,
});

const none = new Set<string>();

describe('courier eligibility', () => {
  it('S20 AS-17: a position stays fresh for 60 seconds', () => {
    expect(POSITION_MAX_AGE_MS).toBe(60_000);
  });

  it.each([
    ['exactly 60 s old', NOW - 60_000, true],
    ['61 s old', NOW - 61_000, false],
    ['60 001 ms old', NOW - 60_001, false],
    ['fresh', NOW, true],
    ['never reported', null, false],
  ] as const)('S20 AS-17: a position %s -> eligible %s', (_n, ts, expected) => {
    expect(isEligible(courier({ positionTs: ts }), NOW, none)).toBe(expected);
  });

  it.each(['OFFLINE', 'BUSY'] as const)(
    'S20 AS-22: a %s courier is not eligible',
    (status) => {
      expect(isEligible(courier({ status }), NOW, none)).toBe(false);
    },
  );

  it('S20 AS-21: a courier holding a live offer is not eligible', () => {
    expect(isEligible(courier({ hasLiveOffer: true }), NOW, none)).toBe(false);
  });

  it('S20 AS-15: a courier offered this delivery before is not eligible again', () => {
    expect(isEligible(courier(), NOW, new Set(['c1']))).toBe(false);
    expect(isEligible(courier(), NOW, new Set(['c2']))).toBe(true);
  });

  it('S20 AS-17: an available, fresh, free, never-offered courier is eligible', () => {
    expect(isEligible(courier(), NOW, none)).toBe(true);
  });
});
