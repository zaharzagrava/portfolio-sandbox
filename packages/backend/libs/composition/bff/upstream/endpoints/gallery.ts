import {
  productGallerySchema,
  type ProductGallery,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** W02 B-1 `GET /api/products/:productId/gallery` (media domain): public, anonymous, no per-visitor data. */
export const productGallery = (productId: string): Endpoint<ProductGallery> => ({
  name: 'gallery',
  upstream: 'media',
  method: 'GET',
  path: `/api/products/${enc(productId)}/gallery`,
  schema: productGallerySchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
