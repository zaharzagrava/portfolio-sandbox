// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound();
  },
}));

import { GET, HEAD } from '@/app/p/[productId]/route';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const call = (handler: typeof GET, productId: string, search = '') =>
  Promise.resolve(handler(new Request(`https://shop.test/p/${productId}${search}`), { params: Promise.resolve({ productId }) })).then(
    (response) => response,
    (error: unknown) => error,
  );

describe('/p/[productId]', () => {
  it('W02 AS-64: answers 308 (a status, not a streamed page) to /products/<id>', async () => {
    const response = (await call(GET, ID)) as Response;
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`/products/${ID}`);
  });

  it('W02 AS-64: keeps every query parameter, repeats included', async () => {
    const response = (await call(GET, ID, '?ref=friend&ad=1&tab=ask&tab=details')) as Response;
    const url = new URL(response.headers.get('location')!, 'http://x');
    expect(url.pathname).toBe(`/products/${ID}`);
    expect(url.searchParams.get('ref')).toBe('friend');
    expect(url.searchParams.get('ad')).toBe('1');
    expect(url.searchParams.getAll('tab')).toEqual(['ask', 'details']);
  });

  it('W02 AS-64: HEAD redirects the same way', async () => {
    const response = (await call(HEAD, ID, '?ad=1')) as Response;
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`/products/${ID}?ad=1`);
  });

  it('W02 AS-64: a non-UUID id renders the not-found page', async () => {
    expect(await call(GET, 'not-a-uuid')).toBeInstanceOf(NotFound);
    expect(await call(GET, '123')).toBeInstanceOf(NotFound);
  });

  it('W02 AS-64: an id is never sent anywhere but the redirect target (no open redirect through the id)', async () => {
    expect(await call(GET, '//evil.example')).toBeInstanceOf(NotFound);
  });
});
