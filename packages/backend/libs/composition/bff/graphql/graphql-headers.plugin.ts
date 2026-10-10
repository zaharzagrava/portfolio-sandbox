import type { GqlContext } from './loaders';

interface WillSendResponseContext {
  request: { http?: { method: string } };
  response: {
    http: { headers: Map<string, string> };
    body?: { kind: string; singleResult?: { errors?: readonly unknown[] } };
  };
  contextValue: GqlContext;
}

/**
 * Response caching rules of the GraphQL endpoint (S48 FR-036, AS-38): an answer to a persisted `GET` without any
 * credential and without errors may sit in a shared cache for 5 s; everything else is `private, no-store`.
 * Structural types on purpose: the executor ships two type trees (ESM and CJS) that do not unify.
 */
export const cacheHeadersPlugin = {
  requestDidStart() {
    return Promise.resolve({
      willSendResponse({
        request,
        response,
        contextValue,
      }: WillSendResponseContext) {
        const body = response.body;
        const anonymous = contextValue.credentials?.kind === 'anonymous';
        const clean =
          body?.kind === 'single' && !body.singleResult?.errors?.length;
        const publicGet = request.http?.method === 'GET' && anonymous && clean;
        response.http.headers.set(
          'cache-control',
          publicGet ? 'public, s-maxage=5' : 'private, no-store',
        );
        return Promise.resolve();
      },
    });
  },
};
