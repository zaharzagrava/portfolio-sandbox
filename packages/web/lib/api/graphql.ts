import { getAccessToken } from './client';

export class GraphQLError extends Error {
  public errors: any[];
  constructor(errors: any[]) {
    super(errors[0]?.message || 'GraphQL Error');
    this.name = 'GraphQLError';
    this.errors = errors;
  }
}

export const gqlClient = {
  async query<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
    const url = process.env.NEXT_PUBLIC_BFF_URL || 'http://localhost:3000/api/graphql';
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    const token = getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: document,
        variables,
      }),
    });

    const result = await response.json();

    if (result.errors) {
      throw new GraphQLError(result.errors);
    }

    return result.data as T;
  },
};
