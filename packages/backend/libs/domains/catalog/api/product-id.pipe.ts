import { Injectable, PipeTransform } from '@nestjs/common';
import { Fatal_NotFoundError } from '@app/common/errors';
import { isUuid } from '../domain/product-input';
import { ProductValidationError } from '../domain/product-errors';

/**
 * Path segments that belong to another capability's route under the same prefix. `search` is S32's
 * (`GET /products/search`, `GET /shops/:shopId/products/search`): until S32 mounts it the catalog answers 404 for it
 * (AS-87) instead of calling it a malformed id (400). S32 registers its controller before the catalog's, or removes
 * this entry (specs/domains/S05-products/gaps.md, S32).
 */
export const RESERVED_PRODUCT_SEGMENTS: readonly string[] = ['search'];

/** A product id in the path: a UUID, otherwise `400 validation_failed` (AS-08, AS-26) or `404` for a reserved segment. */
@Injectable()
export class ProductIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (RESERVED_PRODUCT_SEGMENTS.includes(value))
      throw new Fatal_NotFoundError({ detail: 'Not found.' });
    if (!isUuid(value)) throw new ProductValidationError(['productId']);
    return value.toLowerCase();
  }
}
