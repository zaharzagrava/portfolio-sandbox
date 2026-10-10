import { Catch } from '@nestjs/common';
import type { GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import {
  BFF_GRAPHQL_REJECTION_CODES,
  BFF_SECTION_CODES,
  type SectionCode,
} from '@marketplace-sandbox/contracts';
import { classify, UpstreamFailure } from '../upstream/upstream-error';
import { ChunkFailure } from './loader-batching';

const MESSAGES: Record<SectionCode, string> = {
  UPSTREAM_TIMEOUT: 'The service did not answer in time.',
  UPSTREAM_UNAVAILABLE: 'The service is unavailable.',
  UPSTREAM_NOT_FOUND: 'The data was not found.',
  UPSTREAM_RATE_LIMITED: 'The service is limiting requests.',
  UPSTREAM_INVALID: 'The service answered with an unusable response.',
  UPSTREAM_OVERLOADED: 'The service is busy.',
  CIRCUIT_OPEN: 'The service is temporarily skipped.',
  BUDGET_EXCEEDED: 'The time budget for this field was used up.',
};

/** The field-level error for a failed upstream call: the closed code, a fixed message, nothing of the upstream. */
export function fieldError(cause: unknown): GraphQLError {
  const failure: UpstreamFailure =
    cause instanceof ChunkFailure ? classify(cause.cause) : classify(cause);
  if (failure.unauthorized)
    return new GraphQLError('Authentication is required.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  return new GraphQLError(MESSAGES[failure.code], {
    extensions: { code: failure.code },
  });
}

/**
 * The global problem+json filter speaks HTTP; a resolver error must reach the executor untouched so it becomes a
 * field error with its `extensions.code`. Bound to the resolver class, it takes precedence over the global filter.
 */
@Catch()
export class GraphqlPassThroughFilter implements GqlExceptionFilter {
  catch(exception: unknown): unknown {
    return exception;
  }
}

export const badUserInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

export const INTROSPECTION_MESSAGE = 'Introspection is disabled.';

const KNOWN_CODES = new Set<string>([
  ...BFF_SECTION_CODES,
  ...BFF_GRAPHQL_REJECTION_CODES,
]);

/**
 * Every error leaving the endpoint has a stable `extensions.code` from the closed set, a message that is ours (or a
 * validation message about the client's own document), and no stack, path of the server, URL or upstream text.
 */
export function formatGraphQLError(
  formatted: GraphQLFormattedError,
): GraphQLFormattedError {
  const code = formatted.extensions?.code;
  // the executor re-labels every validation error; this one has a code of its own that clients switch on
  if (formatted.message === INTROSPECTION_MESSAGE)
    return {
      message: formatted.message,
      locations: formatted.locations,
      extensions: { code: 'INTROSPECTION_DISABLED' },
    };
  if (typeof code === 'string' && KNOWN_CODES.has(code)) {
    const { stacktrace: _stack, ...extensions } = formatted.extensions ?? {};
    return { ...formatted, extensions };
  }
  if (
    code === 'GRAPHQL_VALIDATION_FAILED' ||
    code === 'GRAPHQL_PARSE_FAILED' ||
    code === 'BAD_USER_INPUT' ||
    code === 'BAD_REQUEST'
  )
    return {
      message: formatted.message,
      locations: formatted.locations,
      path: formatted.path,
      extensions: {
        code: code === 'BAD_REQUEST' ? 'GRAPHQL_VALIDATION_FAILED' : code,
      },
    };
  return {
    message: 'Internal error.',
    path: formatted.path,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
}
