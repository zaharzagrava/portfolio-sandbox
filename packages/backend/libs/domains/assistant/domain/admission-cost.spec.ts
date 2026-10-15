import {
  ADMISSION_STEPS,
  PROVIDER_TPM_BUDGET,
  admissionCost,
  firstAdmissionFailure,
  type AdmissionStep,
} from './admission';

describe('S46 AS-37: weighted admission cost', () => {
  it.each([
    [0, 0, 0, 17_000],
    [4, 0, 0, 17_001],
    [5, 0, 0, 17_002],
    [4_000, 4_000, 4_000, 20_000],
    [1, 1, 1, 17_001],
    [8_000_000, 0, 0, 2_000_000],
    [7_932_000, 0, 0, 2_000_000],
    [7_931_996, 0, 0, 1_999_999],
    [5_000_000, 5_000_000, 5_000_000, 2_000_000],
  ])('S46 AS-37: system %s + tools %s + text %s chars -> %s', (system, tools, text, cost) => {
    expect(admissionCost({ systemChars: system, toolsChars: tools, textChars: text })).toBe(cost);
  });

  it('S46 AS-37: the cap is the provider budget', () => {
    expect(PROVIDER_TPM_BUDGET).toBe(2_000_000);
  });
});

describe('S46 AS-06: admission order', () => {
  it('S46 AS-06: the order is the spec order', () => {
    expect([...ADMISSION_STEPS]).toEqual([
      'authentication',
      'validation',
      'idempotency',
      'ownership',
      'rate',
      'input_moderation',
      'conversation_size',
      'quota',
      'conversation_lock',
      'user_slots',
      'provider_budget',
      'breakers',
    ]);
  });

  it.each<[string, AdmissionStep[], AdmissionStep | null]>([
    ['nothing failing', [], null],
    ['exhausted allowance + busy conversation', ['conversation_lock', 'quota'], 'quota'],
    ['foreign conversation + exhausted allowance', ['quota', 'ownership'], 'ownership'],
    ['rate + moderation', ['input_moderation', 'rate'], 'rate'],
    ['everything', [...ADMISSION_STEPS].reverse(), 'authentication'],
    ['breakers alone', ['breakers'], 'breakers'],
    ['budget + breakers', ['breakers', 'provider_budget'], 'provider_budget'],
  ])('S46 AS-06: %s -> %s', (_n, failing, expected) => {
    expect(firstAdmissionFailure(new Set(failing))).toBe(expected);
  });
});
