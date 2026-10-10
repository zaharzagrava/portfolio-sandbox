import {
  auctionsResponseSchema,
  type AuctionPublic,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S21 `GET /api/auctions?productIds=`: the page takes the first or `null`. */
export const auctionsFor = (
  productIds: readonly string[],
): Endpoint<AuctionPublic[]> => ({
  name: 'auction',
  upstream: 'auctions',
  method: 'GET',
  path: '/api/auctions',
  query: { productIds: productIds.join(',') },
  schema: auctionsResponseSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
