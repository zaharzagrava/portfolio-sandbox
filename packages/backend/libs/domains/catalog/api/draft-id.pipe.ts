import { Injectable, PipeTransform } from '@nestjs/common';
import { DraftValidationError } from '../domain/draft-errors';
import { isUuid } from '../domain/product-input';

/** A draft or version id in the path: a UUID, otherwise `400 validation_failed` before any store is touched. */
@Injectable()
export class DraftIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw new DraftValidationError(['id']);
    return value.toLowerCase();
  }
}
