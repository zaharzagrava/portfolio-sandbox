import { Injectable, PipeTransform } from '@nestjs/common';
import { isUuid } from '../domain/product-input';
import { ProductValidationError } from '../domain/product-errors';

/** A product id in the path: a UUID, otherwise `400 validation_failed` (AS-08, AS-26). */
@Injectable()
export class ProductIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw new ProductValidationError(['productId']);
    return value.toLowerCase();
  }
}
