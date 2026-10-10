import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, gqlClient } from './graphql';

const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);
const answer = (body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

describe('S48 GraphQL client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('S48 AS-42: posts same-origin with the cookie jar and the CSRF header, and never a bearer token', async () => {
    stubCookies('__Host-bff-csrf=tok.en; theme=dark');
    const spy = answer({ data: { product: { id: 'p1' } } });
    const data = await gqlClient.query<{ product: { id: string } }>('{ product(id: "p1") { id } }', { a: 1 });
    expect(data.product.id).toBe('p1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/graphql');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('tok.en');
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({ query: '{ product(id: "p1") { id } }', variables: { a: 1 } });
  });

  it('S48 AS-29: field errors reach the caller with their extensions.code', async () => {
    stubCookies('');
    answer({ data: null, errors: [{ message: 'The service is unavailable.', path: ['product'], extensions: { code: 'UPSTREAM_UNAVAILABLE' } }] });
    const error = await gqlClient.query('{ product(id: "p1") { id } }').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).errors[0].extensions.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
