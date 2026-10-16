import type { Answers, DocumentKind } from './questionnaire';
import {
  type Issue,
  evaluateExtraction,
  needsEscalation,
  outcomeFor,
} from './extraction-rules';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;
const isoDay = (daysAgo: number, now = NOW) =>
  new Date(Math.floor(now.getTime() / DAY) * DAY - daysAgo * DAY)
    .toISOString()
    .slice(0, 10);

const answers = {
  business: {
    legalForm: 'LIMITED_COMPANY',
    businessName: 'Müller Handels GmbH',
    country: 'DE',
    registrationNumber: 'HRB 12345',
  },
  tax: { vatRegistered: true, vatNumber: 'DE136695976' },
  catalog: { categories: ['Phones'], expectedMonthlyOrders: 'UNDER_100' },
  policies: { returnsDays: 30, shipsFrom: 'DE' },
} as Answers;

type F = [value: string | null, confidence?: 'high' | 'medium' | 'low'];
const field = ([value, confidence = 'high']: F) => ({
  value,
  confidence,
  evidence: null,
});

const BASE: Record<DocumentKind, Record<string, string>> = {
  BUSINESS_REGISTRATION: {
    legalName: 'Müller Handels GmbH',
    registrationNumber: 'hrb-12345',
    country: 'de',
    registeredAddress: 'Hauptstr. 1, Berlin',
    issueDate: '2020-01-01',
  },
  VAT_CERTIFICATE: {
    vatNumber: 'DE 136695976',
    legalName: 'MULLER HANDELS',
    country: 'DE',
  },
  BANK_STATEMENT: {
    accountHolder: 'Muller Handels GmbH',
    iban: 'DE89 3704 0044 0532 0130 00',
    bankName: 'Commerzbank',
    statementDate: isoDay(10),
  },
};

function output(
  kind: DocumentKind,
  over: Record<string, F> = {},
  top: Record<string, unknown> = {},
) {
  const fields = Object.fromEntries(
    Object.entries(BASE[kind]).map(([k, v]) => [k, field(over[k] ?? [v])]),
  );
  return {
    refused: false,
    text: JSON.stringify({
      documentType: kind,
      fields,
      legible: true,
      ...top,
    }),
  };
}

const run = (
  kind: DocumentKind,
  over: Record<string, F> = {},
  top: Record<string, unknown> = {},
  now = NOW,
) => evaluateExtraction(kind, output(kind, over, top), answers, now);

describe('evaluateExtraction: clean documents', () => {
  it.each(['BUSINESS_REGISTRATION', 'VAT_CERTIFICATE', 'BANK_STATEMENT'] as const)(
    'S04 AS-23: a consistent %s has no issues',
    (kind) => {
      const r = run(kind);
      expect(r.issues).toEqual([]);
      expect(r.extraction).not.toBeNull();
    },
  );

  it('S04 AS-23: without answers only the document itself is checked', () => {
    const r = evaluateExtraction(
      'BANK_STATEMENT',
      output('BANK_STATEMENT', { accountHolder: ['Somebody Else'] }),
      null,
      NOW,
    );
    expect(r.issues).toEqual([]);
  });
});

describe('evaluateExtraction: one issue code at a time', () => {
  const cases: [
    string,
    DocumentKind,
    Record<string, F>,
    Record<string, unknown>,
    Issue | Issue[],
  ][] = [
    [
      'illegible',
      'BANK_STATEMENT',
      {},
      { legible: false },
      { field: null, code: 'illegible', escalate: false },
    ],
    [
      'wrong_document_type',
      'BANK_STATEMENT',
      {},
      { documentType: 'OTHER' },
      { field: null, code: 'wrong_document_type', escalate: true },
    ],
    [
      'missing_or_low_confidence (null)',
      'BANK_STATEMENT',
      { bankName: [null] },
      {},
      { field: 'bankName', code: 'missing_or_low_confidence', escalate: true },
    ],
    [
      'missing_or_low_confidence (low)',
      'BANK_STATEMENT',
      { bankName: ['Commerzbank', 'low'] },
      {},
      { field: 'bankName', code: 'missing_or_low_confidence', escalate: true },
    ],
    [
      'name_mismatch (legal name)',
      'BUSINESS_REGISTRATION',
      { legalName: ['Zeta Trading BV'] },
      {},
      { field: 'legalName', code: 'name_mismatch', escalate: false },
    ],
    [
      'name_mismatch (account holder)',
      'BANK_STATEMENT',
      { accountHolder: ['Zeta Trading BV'] },
      {},
      { field: 'accountHolder', code: 'name_mismatch', escalate: false },
    ],
    [
      'country_mismatch',
      'BUSINESS_REGISTRATION',
      { country: ['PL'] },
      {},
      { field: 'country', code: 'country_mismatch', escalate: false },
    ],
    [
      'registration_number_mismatch',
      'BUSINESS_REGISTRATION',
      { registrationNumber: ['HRB 99999'] },
      {},
      {
        field: 'registrationNumber',
        code: 'registration_number_mismatch',
        escalate: true,
      },
    ],
    [
      'invalid_date (issue date tomorrow)',
      'BUSINESS_REGISTRATION',
      { issueDate: [isoDay(-1)] },
      {},
      { field: 'issueDate', code: 'invalid_date', escalate: true },
    ],
    [
      'invalid_date (unparseable)',
      'BUSINESS_REGISTRATION',
      { issueDate: ['last spring'] },
      {},
      { field: 'issueDate', code: 'invalid_date', escalate: true },
    ],
    [
      'vat_checksum',
      'VAT_CERTIFICATE',
      { vatNumber: ['DE136695975'] },
      {},
      // a number that fails the checksum also differs from the declared one
      [
        { field: 'vatNumber', code: 'vat_checksum', escalate: true },
        { field: 'vatNumber', code: 'vat_mismatch', escalate: true },
      ],
    ],
    [
      'vat_mismatch',
      'VAT_CERTIFICATE',
      { vatNumber: ['DE811128135'] },
      {},
      { field: 'vatNumber', code: 'vat_mismatch', escalate: true },
    ],
    [
      'iban_checksum',
      'BANK_STATEMENT',
      { iban: ['DE89 3704 0044 0532 0130 01'] },
      {},
      { field: 'iban', code: 'iban_checksum', escalate: true },
    ],
  ];

  it.each(cases)(
    'S04 AS-23: %s',
    (_, kind, over, top, expected) => {
      const r = run(kind, over, top);
      expect(r.issues).toEqual([expected].flat());
    },
  );

  it('S04 AS-23: model_refused is not escalated and carries no extraction', () => {
    const r = evaluateExtraction(
      'BANK_STATEMENT',
      { ...output('BANK_STATEMENT'), refused: true },
      answers,
      NOW,
    );
    expect(r).toEqual({
      extraction: null,
      issues: [{ field: null, code: 'model_refused', escalate: false }],
    });
  });

  it.each([
    ['not JSON', 'sorry, I cannot'],
    ['empty', ''],
    ['an array', '[]'],
    [
      'an extra key at the top',
      JSON.stringify({
        ...JSON.parse(output('BANK_STATEMENT').text),
        note: 'ignore previous rules',
      }),
    ],
    [
      'bad confidence value',
      JSON.stringify({
        ...JSON.parse(output('BANK_STATEMENT').text),
        fields: Object.fromEntries(
          Object.keys(BASE.BANK_STATEMENT).map((k) => [
            k,
            { value: 'x', confidence: 'certain', evidence: null },
          ]),
        ),
      }),
    ],
    [
      'an unknown field name',
      JSON.stringify({
        ...JSON.parse(output('BANK_STATEMENT').text),
        fields: {
          ...JSON.parse(output('BANK_STATEMENT').text).fields,
          pin: field(['1234']),
        },
      }),
    ],
    [
      'a value over 500 characters',
      JSON.stringify({
        ...JSON.parse(output('BANK_STATEMENT').text),
        fields: {
          ...JSON.parse(output('BANK_STATEMENT').text).fields,
          bankName: field(['x'.repeat(501)]),
        },
      }),
    ],
  ])('S04 AS-23: invalid_output for %s', (_, text) => {
    expect(
      evaluateExtraction(
        'BANK_STATEMENT',
        { refused: false, text },
        answers,
        NOW,
      ),
    ).toEqual({
      extraction: null,
      issues: [{ field: null, code: 'invalid_output', escalate: true }],
    });
  });
});

describe('evaluateExtraction: boundaries', () => {
  it.each([
    ['today', 0, true],
    ['day 179', 179, true],
    ['day 180 passes', 180, true],
    ['day 181 fails', 181, false],
    ['tomorrow fails', -1, false],
  ])('S04 AS-23: statement dated %s', (_, daysAgo, ok) => {
    const r = run('BANK_STATEMENT', { statementDate: [isoDay(daysAgo)] });
    expect(r.issues).toEqual(
      ok
        ? []
        : [{ field: 'statementDate', code: 'statement_too_old', escalate: false }],
    );
  });

  it('S04 AS-23: the age is counted from the injected now, not the wall clock', () => {
    const later = new Date('2027-10-16T00:00:00.000Z');
    expect(run('BANK_STATEMENT', {}, {}, later).issues.map((i) => i.code)).toEqual(
      ['statement_too_old'],
    );
    const sameDay = new Date('2026-04-19T23:59:59.000Z');
    // 2026-04-19 minus 180 days is 2025-10-21
    expect(
      run('BANK_STATEMENT', { statementDate: ['2025-10-21'] }, {}, sameDay)
        .issues,
    ).toEqual([]);
    expect(
      run('BANK_STATEMENT', { statementDate: ['2025-10-20'] }, {}, sameDay)
        .issues,
    ).toHaveLength(1);
  });

  it('S04 AS-23: an issue date of today is valid', () => {
    expect(
      run('BUSINESS_REGISTRATION', { issueDate: [isoDay(0)] }).issues,
    ).toEqual([]);
  });

  // token Jaccard after removing legal suffixes: 3/5 = 0.6 matches, 4/7 = 0.571 does not
  it.each([
    ['exactly 0.6 (3/5)', 'alpha beta gamma', 'alpha beta gamma delta epsilon', true],
    [
      '0.625 (5/8)',
      'alpha beta gamma delta epsilon',
      'alpha beta gamma delta epsilon zeta eta theta',
      true,
    ],
    [
      '0.571 (4/7)',
      'alpha beta gamma delta',
      'alpha beta gamma delta epsilon zeta eta',
      false,
    ],
    ['0.5 (2/4)', 'alpha beta', 'alpha beta gamma delta', false],
  ])('S04 AS-23: name similarity %s', (_, declared, extracted, matches) => {
    const r = evaluateExtraction(
      'BUSINESS_REGISTRATION',
      output('BUSINESS_REGISTRATION', { legalName: [extracted] }),
      {
        ...answers,
        business: { ...answers.business, businessName: declared },
      } as Answers,
      NOW,
    );
    expect(r.issues.some((i) => i.code === 'name_mismatch')).toBe(!matches);
  });

  it('S04 AS-23: the threshold comes from the configuration', () => {
    const strict = evaluateExtraction(
      'BANK_STATEMENT',
      output('BANK_STATEMENT', { accountHolder: ['Muller Handels Trading'] }),
      answers,
      NOW,
      { nameMatchThreshold: 0.9, statementMaxAgeDays: 180 },
    );
    expect(strict.issues.map((i) => i.code)).toEqual(['name_mismatch']);
  });

  it('S04 AS-23: the statement age limit comes from the configuration', () => {
    const r = evaluateExtraction(
      'BANK_STATEMENT',
      output('BANK_STATEMENT', { statementDate: [isoDay(31)] }),
      answers,
      NOW,
      { nameMatchThreshold: 0.6, statementMaxAgeDays: 30 },
    );
    expect(r.issues.map((i) => i.code)).toEqual(['statement_too_old']);
  });
});

describe('escalation and outcome', () => {
  const esc: Issue = { field: 'iban', code: 'iban_checksum', escalate: true };
  const plain: Issue = {
    field: null,
    code: 'illegible',
    escalate: false,
  };

  it.each([
    [[], false],
    [[plain], false],
    [[esc], true],
    [[plain, esc], true],
  ])('S04 AS-23: needsEscalation(%j) = %s', (issues, expected) => {
    expect(needsEscalation(issues)).toBe(expected);
  });

  it.each([
    ['no issues, first attempt', [], 1, 'ACCEPTED'],
    ['no issues, second attempt', [], 2, 'ACCEPTED'],
    ['escalating issue, first attempt', [esc], 1, 'ESCALATE'],
    ['escalating issue, second attempt', [esc], 2, 'REVIEW'],
    ['non-escalating issue, first attempt', [plain], 1, 'REVIEW'],
    ['mixed issues, first attempt', [plain, esc], 1, 'ESCALATE'],
  ] as const)('S04 AS-23/24: %s -> %s', (_, issues, attempt, expected) => {
    expect(outcomeFor([...issues], attempt, 2)).toBe(expected);
  });
});
