import { describe, expect, it, vi } from 'vitest';

class Redirected extends Error {
  constructor(readonly url: string) {
    super('redirect');
  }
}
class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  permanentRedirect: (url: string) => {
    throw new Redirected(url);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

import ShortProductLink from '@/app/p/[productId]/page';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const run = (productId: string, search: Record<string, string | string[]> = {}) =>
  ShortProductLink({ params: Promise.resolve({ productId }), searchParams: Promise.resolve(search) }).then(
    () => undefined,
    (error: unknown) => error,
  );

describe('/p/[productId]', () => {
  it('W02 AS-64: redirects permanently to /products/<id>', async () => {
    const error = await run(ID);
    expect(error).toBeInstanceOf(Redirected);
    expect((error as Redirected).url).toBe(`/products/${ID}`);
  });

  it('W02 AS-64: keeps every query parameter, repeats included', async () => {
    const error = (await run(ID, { ref: 'friend', ad: '1', tab: ['ask', 'details'] })) as Redirected;
    const url = new URL(error.url, 'http://x');
    expect(url.pathname).toBe(`/products/${ID}`);
    expect(url.searchParams.get('ref')).toBe('friend');
    expect(url.searchParams.get('ad')).toBe('1');
    expect(url.searchParams.getAll('tab')).toEqual(['ask', 'details']);
  });

  it('W02 AS-64: a non-UUID id renders the not-found page', async () => {
    expect(await run('not-a-uuid')).toBeInstanceOf(NotFound);
    expect(await run('123')).toBeInstanceOf(NotFound);
  });

  it('W02 AS-64: an id is never sent anywhere but the redirect target (no open redirect through the id)', async () => {
    expect(await run('//evil.example')).toBeInstanceOf(NotFound);
  });
});
