import { validateTheme } from './theme';

const VALID: unknown[] = [
  {},
  { primaryColor: '#0a0B0c' },
  { textColor: '#000000', backgroundColor: '#ffffff' },
  { borderRadius: '0px' },
  { borderRadius: '24px' },
  { borderRadius: '8px' },
  { fontFamily: 'system' },
  { fontFamily: 'serif' },
  { fontFamily: 'mono' },
  { buttonLabel: 'Buy now' },
  { buttonLabel: 'x'.repeat(40) },
  { buttonLabel: 'Acheter & payer' },
];

const INVALID: [unknown, string][] = [
  [{ color: '#000000' }, 'color'],
  [{ primaryColor: 'red' }, 'primaryColor'],
  [{ primaryColor: '#fff' }, 'primaryColor'],
  [{ primaryColor: 'url(javascript:alert(1))' }, 'primaryColor'],
  [{ primaryColor: '#12345g' }, 'primaryColor'],
  [{ borderRadius: '25px' }, 'borderRadius'],
  [{ borderRadius: '-1px' }, 'borderRadius'],
  [{ borderRadius: '8' }, 'borderRadius'],
  [{ borderRadius: '8em' }, 'borderRadius'],
  [{ fontFamily: 'Comic Sans' }, 'fontFamily'],
  [{ buttonLabel: '' }, 'buttonLabel'],
  [{ buttonLabel: 'x'.repeat(41) }, 'buttonLabel'],
  [{ buttonLabel: '<b>x</b>' }, 'buttonLabel'],
  [{ buttonLabel: 'line\nbreak' }, 'buttonLabel'],
  [{ buttonLabel: 'tab\there' }, 'buttonLabel'],
  [{ buttonLabel: 5 }, 'buttonLabel'],
  [{ primaryColor: 5 }, 'primaryColor'],
  [{ primaryColor: null }, 'primaryColor'],
  ['red', 'theme'],
  [null, 'theme'],
  [[], 'theme'],
];

describe('S44 AS-04 theme allowlist', () => {
  it.each(VALID.map((v) => [v]))('S44 AS-04: accepts %j as given', (theme) => {
    expect(validateTheme(theme)).toEqual({ ok: true, theme });
  });

  it.each(INVALID)('S44 AS-04: rejects %j at %s', (theme, key) => {
    expect(validateTheme(theme)).toEqual({ ok: false, key });
  });
});
