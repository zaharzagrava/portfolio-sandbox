import {
  Controller,
  Get,
  Headers,
  Param,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall } from '@app/domains/identity';
import {
  VersionEtagInterceptor,
  buildCacheControl,
  withEtag,
} from '@app/infrastructure/cache';
import { PreviewService } from '../application/preview.service';
import { PublicReadService } from '../application/public-read.service';
import { StoryError } from '../domain/errors';
import { LIMITS } from '../domain/limits';

/** `public, s-maxage=300, stale-while-revalidate=86400`: the CDN does almost all the work (S27 FR-021). */
const STORY_CACHE_CONTROL = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: LIMITS.edgeTtlSec,
  staleWhileRevalidateSec: LIMITS.staleWhileRevalidateSec,
});
/** A negative answer is cached briefly: long enough to blunt scans, short enough not to delay a reveal. */
const NOT_FOUND_CACHE_CONTROL = buildCacheControl({
  visibility: 'public',
  sMaxAgeSec: LIMITS.negativeTtlSec,
});
const PREVIEW_CACHE_CONTROL = buildCacheControl({
  visibility: 'private',
  noStore: true,
});

/**
 * The anonymous story routes (S27 "Provides"). Headers are the CDN contract: tags `story:<id>` and `shop:<id>`, a strong
 * ETag the cache toolkit answers `304` for, the served locale, and no `Vary`: nothing here depends on the caller.
 */
@ApiTags('stories')
@Controller()
export class PublicStoriesController {
  constructor(
    private readonly reads: PublicReadService,
    private readonly previews: PreviewService,
  ) {}

  /** Declared before the path with three parameters is irrelevant (different depth), but kept first for readers. */
  @Firewall({ anonymous: true })
  @Get('stories/preview')
  async preview(
    @Headers('x-preview-token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const story = await this.previews.read(token);
      res.setHeader('Cache-Control', PREVIEW_CACHE_CONTROL);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return story;
    } catch (error) {
      res.setHeader('Cache-Control', 'no-store');
      throw error;
    }
  }

  @Firewall({ anonymous: true })
  @UseInterceptors(VersionEtagInterceptor)
  @Get('stories/:shopSlug/:slug/:locale')
  async story(
    @Param('shopSlug') shopSlug: string,
    @Param('slug') slug: string,
    @Param('locale') locale: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const served = await this.reads.get(shopSlug, slug, locale);
      res.setHeader('Cache-Control', STORY_CACHE_CONTROL);
      res.setHeader('Cache-Tag', served.tag);
      res.setHeader('Content-Language', served.dto.locale);
      return withEtag(served.dto, served.etag);
    } catch (error) {
      if (error instanceof StoryError && error.storyCode === 'story_not_found')
        res.setHeader('Cache-Control', NOT_FOUND_CACHE_CONTROL);
      throw error;
    }
  }
}
