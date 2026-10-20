import { Injectable } from '@nestjs/common';
import type { ProductImageResolver } from '../../domain/ports';

/**
 * Bound until S29 exports `MediaQueryService.getReadyMediaByIds`: no media is "ready" for search, items carry
 * `imageUrl: null` (neutral, S32 gaps.md "Deferred until a later pass").
 */
@Injectable()
export class NullImageResolver implements ProductImageResolver {
  thumbnails(): Promise<Map<string, string>> {
    return Promise.resolve(new Map());
  }
}
