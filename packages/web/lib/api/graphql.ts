import { csrfHeaders } from './csrf';

export class GraphQLError extends Error {
  public errors: { message?: string; path?: unknown[]; extensions?: { code?: string } & Record<string, unknown> }[];
  constructor(errors: GraphQLError['errors']) {
    super(errors[0]?.message || 'GraphQL Error');
    this.name = 'GraphQLError';
    this.errors = errors;
  }
}

/**
 * GraphQL through the BFF on the web app's own origin (`/api/graphql` is rewritten to the BFF). A signed-in browser is
 * identified by its HttpOnly session cookie and proves intent with the readable CSRF cookie echoed in `X-CSRF-Token`
 * (S48 FR-039); the client keeps no token in memory and sends no bearer header. Branch on `errors[i].extensions.code`.
 */
export const gqlClient = {
  async query<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify({ query: document, variables }),
    });

    const result = await response.json();

    if (result.errors) {
      throw new GraphQLError(result.errors);
    }

    return result.data as T;
  },
};
