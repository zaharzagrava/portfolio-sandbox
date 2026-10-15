// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));

import { POST } from '@/app/api/attribution/ref/route';
import { REF_COOKIE, isValidRefCode } from './ref-code';
import { getRefCode } from './ref.server';

const ORIGIN = 'https://shop.example.test';
const call = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }, raw?: string) =>
  POST(
    new Request(`${ORIGIN}/api/attribution/ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw ?? JSON.stringify(body),
    }) as never,
  );

beforeEach(() => {
  for (const key of Object.keys(jar)) delete jar[key];
});

describe('referral cookie', () => {
  it.each([
    ['a', true],
    ['Ab9_-x', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['', false],
    ['has space', false],
    ['semi;colon', false],
    ['new\nline', false],
    ['dot.dot', false],
    ['é', false],
    ['x=y', false],
    [undefined, false],
    [42, false],
    [null, false],
  ])('W02 AS-63: code validation table: %j is valid=%s', (code, valid) => {
    expect(isValidRefCode(code)).toBe(valid);
  });

  it('W02 AS-63: the route answers 204 with the exact Set-Cookie', async () => {
    const response = await call({ code: 'Ab9_-x' });
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBe('__Host-ref=Ab9_-x; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it.each([
    ['too long', { code: 'a'.repeat(65) }],
    ['empty', { code: '' }],
    ['illegal characters', { code: 'a;b' }],
    ['not a string', { code: 12 }],
    ['missing', {}],
    ['not an object', 'abc'],
  ])('W02 AS-63: an invalid code (%s) changes nothing', async (_name, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('W02 AS-63: a body that is not JSON changes nothing', async () => {
    const response = await call(null, { origin: ORIGIN }, '{not json');
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['another origin', { origin: 'https://evil.example.test' }],
    ['no origin', {}],
    ['an opaque origin', { origin: 'null' }],
  ])('W02 AS-63: same-origin only: %s sets nothing', async (_name, headers) => {
    const response = await call({ code: 'abc' }, headers);
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('W02 AS-63: the last click replaces the earlier code', async () => {
    const first = await call({ code: 'first' });
    const second = await call({ code: 'second' });
    expect(first.headers.get('set-cookie')).toContain('__Host-ref=first;');
    expect(second.headers.get('set-cookie')).toContain('__Host-ref=second;');
  });

  it('W02 AS-63: getRefCode returns the stored code, and null for a missing or malformed cookie', async () => {
    expect(await getRefCode()).toBeNull();
    jar[REF_COOKIE] = 'Ab9_-x';
    expect(await getRefCode()).toBe('Ab9_-x');
    jar[REF_COOKIE] = 'bad value;';
    expect(await getRefCode()).toBeNull();
  });
});
