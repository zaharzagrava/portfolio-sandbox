import {
  productVideosSchema,
  type ProductVideos,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S30 `GET /api/products/:productId/videos`. */
export const productVideos = (productId: string): Endpoint<ProductVideos> => ({
  name: 'videos',
  upstream: 'video',
  method: 'GET',
  path: `/api/products/${enc(productId)}/videos`,
  schema: productVideosSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
