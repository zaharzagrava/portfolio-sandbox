import { describe, expect, it, vi } from 'vitest';
import { acceptIdentityMessage, hostOriginOf, MESSAGE_TYPES, postToHost } from './messages';

const HOST = 'https://www.my-shop.com';
const parent = { postMessage: vi.fn() } as unknown as Window;
const other = { postMessage: vi.fn() } as unknown as Window;

const context = { parent, hostOrigin: HOST };
const message = (overrides: Partial<{ source: unknown; origin: string; data: unknown }> = {}) => ({
  source: parent as unknown,
  origin: HOST,
  data: { type: 'marketplace:identity', token: 'tok-1' } as unknown,
  ...overrides,
});

describe('W07 widget messages: receiving (AS-40)', () => {
  it('W07 AS-40: an identity message from the parent window and the registered host origin is accepted', () => {
    expect(acceptIdentityMessage(message(), context)).toEqual({ token: 'tok-1' });
  });

  it('W07 AS-40: a null token (the host has no answer) is accepted and means "no customer"', () => {
    expect(acceptIdentityMessage(message({ data: { type: 'marketplace:identity', token: null } }), context)).toEqual({ token: null });
  });

  it.each([
    ['another window', { source: other }],
    ['no source', { source: null }],
    ['another origin', { origin: 'https://evil.example' }],
    ['a look-alike origin', { origin: 'https://www.my-shop.com.evil.example' }],
    ['the same host over http', { origin: 'http://www.my-shop.com' }],
    ['an empty origin', { origin: '' }],
    ['the opaque origin "null"', { origin: 'null' }],
  ])('W07 AS-40: a message from %s is ignored silently', (_label, override) => {
    expect(acceptIdentityMessage(message(override), context)).toBeNull();
  });

  it.each([
    ['a string', 'marketplace:identity'],
    ['null', null],
    ['an array', ['marketplace:identity', 'x']],
    ['an unknown type', { type: 'marketplace:other', token: 'x' }],
    ['the close type', { type: 'marketplace:close' }],
    ['no type', { token: 'x' }],
    ['a numeric token', { type: 'marketplace:identity', token: 7 }],
    ['an object token', { type: 'marketplace:identity', token: { a: 1 } }],
    ['an empty token', { type: 'marketplace:identity', token: '' }],
    ['a token that is too long', { type: 'marketplace:identity', token: 'x'.repeat(4097) }],
    ['a missing token', { type: 'marketplace:identity' }],
    ['extra fields', { type: 'marketplace:identity', token: 'x', extra: 1 }],
  ])('W07 AS-40: a malformed payload (%s) is ignored silently', (_label, data) => {
    expect(acceptIdentityMessage(message({ data }), context)).toBeNull();
  });

  it('W07 AS-40: nothing is accepted when the host origin is not known', () => {
    expect(acceptIdentityMessage(message(), { parent, hostOrigin: null })).toBeNull();
    expect(acceptIdentityMessage(message({ origin: '*' }), { parent, hostOrigin: '*' })).toBeNull();
  });
});

describe('W07 widget messages: sending (AS-40)', () => {
  it('W07 AS-40: need-identity and close go to the parent with the registered host origin as the target, never "*"', () => {
    const win = { postMessage: vi.fn() };
    expect(postToHost(win as unknown as Window, HOST, { type: MESSAGE_TYPES.needIdentity })).toBe(true);
    expect(postToHost(win as unknown as Window, HOST, { type: MESSAGE_TYPES.close })).toBe(true);
    expect(win.postMessage.mock.calls).toEqual([
      [{ type: 'marketplace:need-identity' }, HOST],
      [{ type: 'marketplace:close' }, HOST],
    ]);
  });

  it.each([[null], [''], ['*'], ['null'], ['not a url'], ['https://www.my-shop.com/path'], ['javascript:alert(1)']])('W07 AS-40: with the host origin %j nothing is posted', (origin) => {
    const win = { postMessage: vi.fn() };
    expect(postToHost(win as unknown as Window, origin, { type: MESSAGE_TYPES.close })).toBe(false);
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it('W07 AS-40: a window that throws on postMessage does not break the application', () => {
    const win = {
      postMessage: () => {
        throw new Error('detached');
      },
    };
    expect(postToHost(win as unknown as Window, HOST, { type: MESSAGE_TYPES.close })).toBe(false);
  });
});

describe('W07 widget messages: who the host is (AS-40)', () => {
  it('W07 AS-40: the host origin is the parent origin the browser reports', () => {
    expect(hostOriginOf({ ancestorOrigins: [HOST], referrer: '' })).toBe(HOST);
  });

  it('W07 AS-40: without ancestor origins the origin of the referrer is used (path and query dropped)', () => {
    expect(hostOriginOf({ ancestorOrigins: undefined, referrer: `${HOST}/shop/page?x=1#y` })).toBe(HOST);
  });

  it.each([
    [{ ancestorOrigins: [], referrer: '' }],
    [{ ancestorOrigins: ['null'], referrer: '' }],
    [{ ancestorOrigins: undefined, referrer: 'not a url' }],
    [{ ancestorOrigins: undefined, referrer: 'javascript:alert(1)' }],
    [{ ancestorOrigins: undefined, referrer: 'data:text/html,x' }],
  ])('W07 AS-40: when the host cannot be determined the answer is null (%j)', (input) => {
    expect(hostOriginOf(input)).toBeNull();
  });
});
