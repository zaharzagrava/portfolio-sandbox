import {
  type Answers,
  AnswersSchema,
  STEP_NAMES,
  STEPS,
  answerIssues,
  requiredDocuments,
} from './questionnaire';

const business = {
  legalForm: 'LIMITED_COMPANY',
  businessName: 'Müller Handels GmbH',
  country: 'DE',
  registrationNumber: 'HRB 12345',
};
const tax = { vatRegistered: true, vatNumber: 'DE136695976' };
const catalog = { categories: ['Phones'], expectedMonthlyOrders: 'UNDER_100' };
const policies = { returnsDays: 30, shipsFrom: 'DE' };

const valid = { business, tax, catalog, policies };
const withTax = (t: unknown, b: unknown = business) => ({
  ...valid,
  business: b,
  tax: t,
});

describe('questionnaire steps', () => {
  it('S04 AS-72: has exactly the four steps', () => {
    expect([...STEP_NAMES].sort()).toEqual(
      ['business', 'catalog', 'policies', 'tax'].sort(),
    );
  });

  it.each(STEP_NAMES)('S04 AS-72: step %s accepts a valid body', (step) => {
    expect(STEPS[step].safeParse(valid[step]).success).toBe(true);
  });

  it.each(STEP_NAMES)('S04 AS-72: step %s refuses an unknown field', (step) => {
    const r = STEPS[step].safeParse({ ...valid[step], extra: 1 });
    expect(r.success).toBe(false);
  });

  it.each([
    ['business', { ...business, businessName: 'A' }],
    ['business', { ...business, businessName: 'A'.repeat(201) }],
    ['business', { ...business, country: 'US' }],
    ['business', { ...business, legalForm: 'COOP' }],
    ['business', { ...business, registrationNumber: '' }],
    ['tax', { vatRegistered: 'yes', vatNumber: null }],
    ['tax', { vatRegistered: true, vatNumber: 'D'.repeat(21) }],
    ['tax', { vatRegistered: true }],
    ['catalog', { ...catalog, categories: [] }],
    ['catalog', { ...catalog, categories: Array(11).fill('Phones') }],
    ['catalog', { ...catalog, expectedMonthlyOrders: 'LOTS' }],
    ['policies', { ...policies, returnsDays: 13 }],
    ['policies', { ...policies, returnsDays: 366 }],
    ['policies', { ...policies, returnsDays: 14.5 }],
    ['policies', { ...policies, shipsFrom: 'US' }],
  ] as const)('S04 AS-72: step %s refuses %j', (step, body) => {
    expect(STEPS[step].safeParse(body).success).toBe(false);
  });

  it.each([
    ['business', { ...business, businessName: 'Ab' }],
    ['business', { ...business, businessName: 'A'.repeat(200) }],
    ['policies', { ...policies, returnsDays: 14 }],
    ['policies', { ...policies, returnsDays: 365 }],
    ['catalog', { ...catalog, categories: Array(10).fill('Phones') }],
  ] as const)('S04 AS-72: step %s accepts the boundary %j', (step, body) => {
    expect(STEPS[step].safeParse(body).success).toBe(true);
  });

  it('S04 AS-72: an empty VAT number counts as no number', () => {
    const r = STEPS.tax.safeParse({ vatRegistered: false, vatNumber: '  ' });
    expect(r.success && r.data.vatNumber).toBeNull();
  });
});

describe('cross-step rules', () => {
  it.each([
    ['registered with a valid number', valid, []],
    [
      'registered without a number',
      withTax({ vatRegistered: true, vatNumber: null }),
      ['tax.vatNumber'],
    ],
    [
      'number without registration',
      withTax({ vatRegistered: false, vatNumber: 'DE136695976' }),
      ['tax.vatNumber'],
    ],
    [
      'number invalid for the country (checksum)',
      withTax({ vatRegistered: true, vatNumber: 'DE136695975' }),
      ['tax.vatNumber'],
    ],
    [
      'number valid for another country',
      withTax({ vatRegistered: true, vatNumber: 'PL5260250274' }),
      ['tax.vatNumber'],
    ],
    [
      'Polish number for a Polish business',
      withTax(
        { vatRegistered: true, vatNumber: 'PL5260250274' },
        { ...business, country: 'PL' },
      ),
      [],
    ],
    [
      'Dutch number for a Dutch business',
      withTax(
        { vatRegistered: true, vatNumber: 'NL004495445B01' },
        { ...business, country: 'NL' },
      ),
      [],
    ],
    [
      'Greek number with the EL prefix',
      withTax(
        { vatRegistered: true, vatNumber: 'EL123456789' },
        { ...business, country: 'GR' },
      ),
      [],
    ],
    [
      'not registered, no number',
      withTax({ vatRegistered: false, vatNumber: null }),
      [],
    ],
  ])('S04 AS-72: %s', (_, answers, paths) => {
    const r = AnswersSchema.safeParse(answers);
    expect(r.success).toBe(paths.length === 0);
    if (!r.success)
      expect(r.error.issues.map((i) => i.path.join('.'))).toEqual(paths);
  });

  it('S04 AS-72: an unknown top-level key is refused', () => {
    expect(AnswersSchema.safeParse({ ...valid, extra: {} }).success).toBe(
      false,
    );
  });

  it('S04 AS-72: a missing step is refused', () => {
    const { policies: _p, ...rest } = valid;
    expect(AnswersSchema.safeParse(rest).success).toBe(false);
  });

  it('S04 AS-72: answerIssues lists {path, message} without values', () => {
    const issues = answerIssues(
      withTax({ vatRegistered: true, vatNumber: 'DE136695975' }),
    );
    expect(issues).toEqual([
      { path: 'tax.vatNumber', message: expect.any(String) },
    ]);
    expect(JSON.stringify(issues)).not.toContain('DE136695975');
  });

  it('S04 AS-72: answerIssues is empty for valid answers', () => {
    expect(answerIssues(valid)).toEqual([]);
  });
});

describe('required documents', () => {
  const answers = (vatRegistered: boolean, country = 'DE'): Answers =>
    ({
      ...valid,
      business: { ...business, country },
      tax: { vatRegistered, vatNumber: vatRegistered ? 'x' : null },
    }) as Answers;

  it.each([
    [
      'VAT registered',
      true,
      'DE',
      ['BUSINESS_REGISTRATION', 'BANK_STATEMENT', 'VAT_CERTIFICATE'],
    ],
    ['not VAT registered', false, 'DE', ['BUSINESS_REGISTRATION', 'BANK_STATEMENT']],
    [
      'VAT registered in PL',
      true,
      'PL',
      ['BUSINESS_REGISTRATION', 'BANK_STATEMENT', 'VAT_CERTIFICATE'],
    ],
    ['not VAT registered in NL', false, 'NL', ['BUSINESS_REGISTRATION', 'BANK_STATEMENT']],
  ])('S04 AS-72: %s', (_, vat, country, expected) => {
    expect(requiredDocuments(answers(vat, country))).toEqual(expected);
  });

  it.each(['SOLE_TRADER', 'PARTNERSHIP', 'LIMITED_COMPANY', 'OTHER'] as const)(
    'S04 AS-72: legal form %s needs the same base documents',
    (legalForm) => {
      const a = answers(false);
      a.business = { ...a.business, legalForm };
      expect(requiredDocuments(a)).toEqual([
        'BUSINESS_REGISTRATION',
        'BANK_STATEMENT',
      ]);
    },
  );
});
