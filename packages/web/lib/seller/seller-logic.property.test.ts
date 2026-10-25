// Track 9 (stateful): rules that must hold for EVERY input, tried with thousands of random values (fast-check).
// A failure is shrunk to the smallest example. Pure logic only: no services needed.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { safeReturnTo, loginHref } from '../auth/return-to';
import { parseMoneyInput } from './money-input';
import { SHOP_PERMISSIONS, pageRequires, shopCan, shopPages, shopWritable } from './permissions';
import { buildQuery, readCursor, readInventoryParams, readOrdersParams, readTeamParams, readUsageParams, readDays } from './search-params';
import { LOW_STOCK_THRESHOLD, stockStatus } from './stock';

const digits = (min: number, max: number) => fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: min, maxLength: max }).map((a) => a.join(''));
// fast-check treats a returned `false` as a failure; vitest's expect() returns something else, so the body result is dropped.
const P = ((...args: unknown[]) => {
  const fn = args.pop() as (...a: unknown[]) => unknown;
  return (fc.property as (...a: unknown[]) => unknown)(...args, (...v: unknown[]) => {
    fn(...v);
  });
}) as typeof fc.property;

describe('money input (never through floats)', () => {
  it('whole + fraction digits parse to exactly the digit string as an integer, for 0, 2 and 3 decimals', () => {
    fc.assert(
      P(fc.integer({ min: 0, max: 3 }), fc.bigInt({ min: BigInt(0), max: BigInt('9007199254740991') }), fc.constantFrom('.', ','), (fd, minor, mark) => {
        const s = minor.toString().padStart(fd + 1, '0');
        const text = fd === 0 ? s : `${s.slice(0, -fd)}${mark}${s.slice(-fd)}`;
        const r = parseMoneyInput(text, fd);
        expect(r).toEqual({ ok: true, minor: Number(minor) }); // round trip: the typed digits ARE the minor units
      }),
      { numRuns: 2000 },
    );
  });
  it('trailing zeros or fewer decimals scale correctly ("12.5" with 2 digits is 1250)', () => {
    fc.assert(
      P(digits(1, 9), digits(0, 2), (whole, frac) => {
        const r = parseMoneyInput(frac === '' ? whole : `${whole}.${frac}`, 2);
        expect(r).toEqual({ ok: true, minor: Number(BigInt(whole) * BigInt(100) + BigInt(frac.padEnd(2, '0') || '0')) });
      }),
      { numRuns: 1000 },
    );
  });
  it('more decimals than the currency allows is refused, never rounded', () => {
    fc.assert(
      P(digits(1, 6), digits(3, 6), (whole, frac) => {
        expect(parseMoneyInput(`${whole}.${frac}`, 2)).toEqual({ ok: false, reason: 'too_many_decimals' });
      }),
    );
  });
  it('a result is always a safe non-negative integer, or a named failure; never throws or NaN', () => {
    fc.assert(
      P(fc.string({ maxLength: 40 }), fc.integer({ min: 0, max: 4 }), (text, fd) => {
        const r = parseMoneyInput(text, fd);
        if (r.ok) {
          expect(Number.isSafeInteger(r.minor)).toBe(true);
          expect(r.minor).toBeGreaterThanOrEqual(0);
        } else {
          expect(['empty', 'negative', 'format', 'too_many_decimals', 'too_large']).toContain(r.reason);
        }
      }),
      { numRuns: 3000 },
    );
  });
  it('a typed minus is never accepted as an amount', () => {
    fc.assert(P(digits(1, 8), (d) => expect(parseMoneyInput(`-${d}`, 2).ok).toBe(false)));
  });
  it('huge digit strings are refused as too large, not rounded to a float', () => {
    fc.assert(P(digits(17, 30).filter((d) => !/^0+/.test(d)), (d) => expect(parseMoneyInput(d, 0)).toEqual({ ok: false, reason: 'too_large' })));
  });
});

describe('stock status boundaries (0 / 1-5 / 6+)', () => {
  it('active: <=0 out, 1..5 low, >=6 in', () => {
    fc.assert(
      P(fc.integer({ min: -1000, max: 100000 }), (q) => {
        const expected = q <= 0 ? 'out' : q <= LOW_STOCK_THRESHOLD ? 'low' : 'in';
        expect(stockStatus(q, 'ACTIVE')).toBe(expected);
      }),
    );
  });
  it('archived overrides any quantity; status is monotone in quantity', () => {
    fc.assert(P(fc.integer({ min: -10, max: 1e6 }), (q) => expect(stockStatus(q, 'ARCHIVED')).toBe('archived')));
    const rank = { out: 0, low: 1, in: 2 } as const;
    fc.assert(
      P(fc.integer({ min: -5, max: 50 }), fc.integer({ min: 0, max: 50 }), (a, d) => {
        expect(rank[stockStatus(a + d, 'ACTIVE') as 'out']).toBeGreaterThanOrEqual(rank[stockStatus(a, 'ACTIVE') as 'out']);
      }),
    );
  });
});

describe('search params and filters', () => {
  const rawValue = fc.oneof(fc.string({ maxLength: 30 }), fc.constant(undefined), fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }));
  it('unsupported values become defaults, never errors', () => {
    fc.assert(
      P(rawValue, rawValue, rawValue, rawValue, (q, status, inStock, cursor) => {
        const p = readInventoryParams({ q, status, inStock, cursor });
        expect(['ACTIVE', 'ARCHIVED']).toContain(p.status);
        if (status !== 'ARCHIVED') expect(p.status).toBe('ACTIVE');
        expect(p.q.length).toBeLessThanOrEqual(200);
        if (inStock !== 'true' && inStock !== 'false') expect(p.inStock).toBeUndefined();
        if (p.cursor !== undefined) expect(p.cursor).toMatch(/^[A-Za-z0-9_\-=.~]+$/);
      }),
      { numRuns: 2000 },
    );
  });
  it('team tab, usage days and overview days always land in the allowed set', () => {
    fc.assert(
      P(rawValue, rawValue, (a, b) => {
        expect(['members', 'invitations', 'roles']).toContain(readTeamParams({ tab: a, status: b }).tab);
        expect([7, 14, 30]).toContain(readUsageParams({ days: a }).days);
        expect([7, 30, 90]).toContain(readDays(b));
      }),
    );
  });
  it('orders status is an upper-case word or undefined', () => {
    fc.assert(P(rawValue, (s) => {
      const st = readOrdersParams({ status: s }).status;
      if (st !== undefined) expect(st).toMatch(/^[A-Z_]{1,32}$/);
    }));
  });
  it('cursor: only short URL-safe text survives, and what survives is returned unchanged', () => {
    fc.assert(P(fc.string({ maxLength: 600 }), (c) => {
      const r = readCursor(c);
      if (r !== undefined) expect(r).toBe(c);
      if (c.length > 512) expect(r).toBeUndefined();
    }), { numRuns: 2000 });
  });
  it('a default value is never written in the address; reading the written address gives the same filters', () => {
    const defaults = { status: 'ACTIVE', inStock: undefined, q: '' };
    fc.assert(
      P(fc.constantFrom('ACTIVE', 'ARCHIVED'), fc.constantFrom('true', 'false', undefined), fc.string({ maxLength: 40 }), (status, inStock, q) => {
        const qs = buildQuery({ q, status, inStock }, defaults);
        const params = new URLSearchParams(qs);
        if (status === 'ACTIVE') expect(params.has('status')).toBe(false);
        if (q === '') expect(params.has('q')).toBe(false);
        if (inStock === undefined) expect(params.has('inStock')).toBe(false);
        const back = readInventoryParams(Object.fromEntries(params));
        expect(back.status).toBe(status);
        expect(back.q).toBe(q.slice(0, 200));
        expect(back.inStock).toBe(inStock === undefined ? undefined : inStock === 'true');
      }),
      { numRuns: 1500 },
    );
  });
  it('buildQuery with every value equal to its default is the empty string', () => {
    fc.assert(P(fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.oneof(fc.string(), fc.integer(), fc.boolean())), (d) => {
      expect(buildQuery(d, d)).toBe('');
    }));
  });
});

describe('permissions', () => {
  const perm = fc.constantFrom(...SHOP_PERMISSIONS);
  it('a shop grants exactly the permissions it lists; missing list grants nothing', () => {
    fc.assert(P(fc.array(perm), perm, (list, p) => expect(shopCan({ myPermissions: list }, p)).toBe(list.includes(p))));
    fc.assert(P(perm, (p) => {
      expect(shopCan(null, p)).toBe(false);
      expect(shopCan({}, p)).toBe(false);
      expect(shopCan({ myPermissions: null }, p)).toBe(false);
    }));
  });
  it('adding a permission never takes another one away (monotone)', () => {
    fc.assert(P(fc.array(perm), perm, perm, (list, extra, p) => {
      if (shopCan({ myPermissions: list }, p)) expect(shopCan({ myPermissions: [...list, extra] }, p)).toBe(true);
    }));
  });
  it('every page needs a known permission', () => {
    for (const page of shopPages) expect(SHOP_PERMISSIONS).toContain(pageRequires[page]);
  });
  it('only an ACTIVE shop is writable, and a not-writable shop always says why', () => {
    fc.assert(P(fc.string({ maxLength: 12 }), (status) => {
      const r = shopWritable({ status });
      expect(r.writable).toBe(status === 'ACTIVE');
      expect(r.reason === null).toBe(r.writable);
    }));
  });
});

describe('returnTo', () => {
  const path = fc.stringMatching(/^\/[a-z0-9\-/]{0,30}$/).filter((p) => !p.startsWith('//'));
  it('a normal same-site path with a query is kept exactly', () => {
    fc.assert(P(path, fc.stringMatching(/^[a-z]{1,6}=[a-z0-9]{0,6}$/), (p, q) => expect(safeReturnTo(`${p}?${q}`)).toBe(`${p}?${q}`)));
  });
  it('another origin, protocol-relative, backslash, control char or non-string becomes "/"', () => {
    fc.assert(P(fc.webUrl(), (u) => expect(safeReturnTo(u)).toBe('/')));
    fc.assert(P(fc.string({ maxLength: 20 }), (s) => expect(safeReturnTo(`//${s}`)).toBe('/')));
    fc.assert(P(fc.string({ maxLength: 20 }), (s) => expect(safeReturnTo(`/${s}\\x`)).toBe('/')));
    fc.assert(P(fc.array(fc.string()), (a) => expect(safeReturnTo(a)).toBe('/')));
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
  });
  it('whatever comes out is "/" or an input that is a safe same-site path (never changed, never another origin)', () => {
    fc.assert(
      P(fc.string({ maxLength: 80 }), (s) => {
        const r = safeReturnTo(s);
        if (r !== '/') {
          expect(r).toBe(s);
          expect(r.startsWith('/') && !r.startsWith('//')).toBe(true);
          expect(r).not.toContain('\\');
          expect(new URL(r, 'https://shop.example').origin).toBe('https://shop.example');
          const decoded = decodeURIComponent(r);
          expect(decoded.startsWith('//')).toBe(false);
          expect(decoded).not.toContain('\\');
        }
      }),
      { numRuns: 5000 },
    );
  });
  it('encoded tricks (%2F%2Fevil, %5C) are refused', () => {
    fc.assert(P(fc.constantFrom('%2F%2F', '%5C', '%2f%2f', '%0d', '%0a', '%00'), fc.stringMatching(/^[a-z.]{1,10}$/), (enc, host) => {
      const raw = enc.toLowerCase() === '%2f%2f' ? `/${enc}${host}` : `/${enc}${host}`;
      const out = safeReturnTo(raw);
      const dec = decodeURIComponent(out);
      expect(dec.startsWith('//') || dec.includes('\\') || /[\u0000-\u001f]/.test(dec)).toBe(false);
    }));
  });
  it('loginHref round-trips the path through the returnTo parameter', () => {
    fc.assert(P(path, (p) => {
      const href = loginHref(p);
      if (p === '/' || p === '') return expect(href).toBe('/login');
      expect(new URL(href, 'https://x.example').searchParams.get('returnTo')).toBe(p);
    }));
  });
});
