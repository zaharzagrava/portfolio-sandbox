import type { ProductImageResolver } from '../domain/ports';

/**
 * Stands in for `MediaQueryService.getReadyMediaByIds` (another domain's R1 service, a system-edge fake, VII.2) until
 * S29 exports it: a media id is ready unless the spec marks it not ready.
 */
export class FakeImageResolver implements ProductImageResolver {
  notReady = new Set<string>();
  down = false;

  static thumb(mediaId: string): string {
    return `https://cdn.test/${mediaId}/thumb.jpg`;
  }

  async thumbnails(mediaIds: string[]): Promise<Map<string, string>> {
    if (this.down) throw new Error('media service unavailable');
    return new Map(
      mediaIds
        .filter((id) => !this.notReady.has(id))
        .map((id) => [id, FakeImageResolver.thumb(id)]),
    );
  }
}
