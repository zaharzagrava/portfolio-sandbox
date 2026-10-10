import {
  flagsResponseSchema,
  type FlagsResponse,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S38 `GET /api/flags`: depends on the caller (bearer, anonymous id), so it never enters the shared cache. */
export const flags = (): Endpoint<FlagsResponse> => ({
  name: 'flags',
  upstream: 'flags',
  method: 'GET',
  path: '/api/flags',
  schema: flagsResponseSchema,
  identity: 'optional',
  anonymousId: true,
  sharedCache: false,
  breaker: true,
});
