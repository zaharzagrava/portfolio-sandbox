import { z } from 'zod';
import { BFF_SECTION_CODES } from './product-page';

/** `extensions.code` values of the BFF GraphQL endpoint: the section codes plus request-level rejections. */
export const BFF_GRAPHQL_REJECTION_CODES = [
  'QUERY_TOO_DEEP',
  'QUERY_TOO_COSTLY',
  'TOO_MANY_ROOT_FIELDS',
  'BAD_USER_INPUT',
  'INTROSPECTION_DISABLED',
  'PERSISTED_QUERY_NOT_FOUND',
  'GRAPHQL_VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INTERNAL_SERVER_ERROR',
] as const;
export const graphqlErrorCodeSchema = z.enum([
  ...BFF_SECTION_CODES,
  ...BFF_GRAPHQL_REJECTION_CODES,
]);
export type GraphqlErrorCode = z.infer<typeof graphqlErrorCodeSchema>;

export const BFF_GRAPHQL_PROBLEM_CODES = [
  'persisted_query_required',
  'persisted_query_mismatch',
  'batching_not_supported',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
] as const;

/** Persisted-query request (Apollo protocol): `extensions.persistedQuery.sha256Hash`. */
export const persistedQueryExtensionSchema = z.object({
  persistedQuery: z.object({
    version: z.literal(1),
    sha256Hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export const graphqlRequestSchema = z.object({
  query: z.string().optional(),
  operationName: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  extensions: persistedQueryExtensionSchema.optional(),
});
export type GraphqlRequest = z.infer<typeof graphqlRequestSchema>;
