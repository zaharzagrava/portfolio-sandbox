import { issueCsrfToken, verifyCsrfToken } from './csrf-token';

const SECRET = 'a'.repeat(48);
const SID = '01a13175-50f3-70df-abf4-cebcd1ed0b70';

describe('CSRF token', () => {
  const valid = issueCsrfToken(SECRET, SID);
  const [random, mac] = valid.split('.');
  const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`;

  const cases: Array<
    [
      string,
      { header: string; cookie: string; sid?: string; secret?: string },
      boolean,
    ]
  > = [
    ['issued for the session', { header: valid, cookie: valid }, true],
    [
      'issued for another session',
      { header: valid, cookie: valid, sid: 'other-session' },
      false,
    ],
    [
      'tampered random part',
      { header: `${flip(random)}.${mac}`, cookie: `${flip(random)}.${mac}` },
      false,
    ],
    [
      'tampered MAC',
      { header: `${random}.${flip(mac)}`, cookie: `${random}.${flip(mac)}` },
      false,
    ],
    [
      'truncated',
      { header: valid.slice(0, 20), cookie: valid.slice(0, 20) },
      false,
    ],
    ['no MAC part', { header: random, cookie: random }, false],
    ['empty header', { header: '', cookie: valid }, false],
    ['empty cookie and header', { header: '', cookie: '' }, false],
    [
      'header differs from cookie',
      { header: valid, cookie: issueCsrfToken(SECRET, SID) },
      false,
    ],
    [
      'upper-cased valid token',
      { header: valid.toUpperCase(), cookie: valid.toUpperCase() },
      false,
    ],
    [
      'signed with a different secret',
      { header: valid, cookie: valid, secret: 'b'.repeat(48) },
      false,
    ],
  ];

  it.each(cases)('S01 AS-53: %s', (_name, input, accepted) => {
    expect(
      verifyCsrfToken({
        secret: input.secret ?? SECRET,
        sid: input.sid ?? SID,
        header: input.header,
        cookie: input.cookie,
      }),
    ).toBe(accepted);
  });

  it('S01 AS-53: never throws on arbitrary input', () => {
    for (const junk of ['\u0000', '.', '..', 'é.é', 'x'.repeat(10_000)])
      expect(() =>
        verifyCsrfToken({
          secret: SECRET,
          sid: SID,
          header: junk,
          cookie: junk,
        }),
      ).not.toThrow();
  });

  it('S01 AS-53: two tokens for one session differ (random part)', () => {
    expect(issueCsrfToken(SECRET, SID)).not.toBe(issueCsrfToken(SECRET, SID));
  });
});
