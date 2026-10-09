import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { StoriesService } from '../application/stories.service';
import { ApiConfigService } from '@app/common/config';

export class CreateStoryDto {
  @ApiProperty() @Matches(/^[a-z0-9][a-z0-9-]{1,80}$/) slug: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  defaultLocale?: string;
}

export class DraftDto {
  @ApiProperty() @IsString() @Length(1, 200) title: string;
  @ApiProperty() @IsArray() blocks: unknown[];
  @ApiPropertyOptional() @IsOptional() @IsObject() seo?: Record<
    string,
    unknown
  >;
}

export class PublishDto {
  @ApiPropertyOptional({ description: 'ISO time; omitted = now' })
  @IsOptional()
  @IsISO8601()
  at?: string;
}

const SITEMAP_PAGE = 50_000; // protocol limit per sitemap file

@ApiTags('stories')
@Controller()
export class StoriesController {
  constructor(
    private readonly stories: StoriesService,
    private readonly config: ApiConfigService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/stories')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateStoryDto,
  ) {
    return this.stories.create(shopId, body.slug, body.defaultLocale);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/stories/:storyId/drafts/:locale')
  draft(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('storyId', ParseUUIDPipe) storyId: string,
    @Param('locale') locale: string,
    @Body() body: DraftDto,
  ) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) throw new NotFoundException();
    return this.stories.saveDraft(shopId, storyId, locale, body);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/stories/:storyId/publish')
  publish(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('storyId', ParseUUIDPipe) storyId: string,
    @Body() body: PublishDto,
  ) {
    return this.stories.publish(
      shopId,
      storyId,
      body.at ? new Date(body.at) : undefined,
    );
  }

  @ShopScoped('products.read')
  @Post('shops/:shopId/stories/:storyId/preview-token')
  previewToken(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('storyId', ParseUUIDPipe) storyId: string,
    @Query('locale') locale = 'en',
  ) {
    return this.stories.previewToken(shopId, storyId, locale);
  }

  /**
   * Public story. CDN contract: fresh for 5 min at the edge, then served stale
   * up to a day while ONE request revalidates; `Cache-Tag` lets publish purge
   * exactly this story's objects; ETag (id-version-locale) answers 304 to
   * conditional requests without a body.
   */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('stories/:shopSlug/:slug')
  async story(
    @Param('shopSlug') shopSlug: string,
    @Param('slug') slug: string,
    @Query('locale') locale: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const story = await this.stories.publicStory(
      shopSlug,
      slug,
      locale ?? 'en',
    );
    const etag = `"${story.id}-v${story.version}-${story.locale}"`;
    res.setHeader('ETag', etag);
    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
    );
    res.setHeader('Cache-Tag', `story:${story.id},shop:${story.shopId}`);
    res.setHeader('Content-Language', story.locale);
    res.setHeader('Vary', 'Accept-Language');
    if (ifNoneMatch === etag) return res.status(304).end();
    res.json(story);
  }

  @Firewall({ anonymous: true })
  @Get('stories/preview')
  async preview(@Query('token') token: string, @Res() res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await this.stories.preview(token ?? ''));
  }

  /** Sitemap index: one child sitemap per 50k URLs. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('sitemaps/stories.xml')
  async index(@Res() res: Response) {
    const pages = Math.max(
      1,
      Math.ceil((await this.stories.publishedCount()) / SITEMAP_PAGE),
    );
    res
      .type('application/xml')
      .setHeader('Cache-Control', 'public, s-maxage=3600');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        Array.from(
          { length: pages },
          (_, i) =>
            `  <sitemap><loc>${xmlEscape(`${this.config.get('backend_host')}/api/sitemaps/stories-${i}.xml`)}</loc></sitemap>`,
        ).join('\n') +
        `\n</sitemapindex>\n`,
    );
  }

  /**
   * One sitemap page STREAMED: rows are written as they are read (keyset
   * batches of 1,000) - constant memory whether the page has 10 or 50,000
   * URLs, and the first bytes go out immediately. hreflang alternates per locale.
   */
  @Firewall({ anonymous: true, skipThrottle: true })
  @Get('sitemaps/stories-:page.xml')
  async page(@Param('page') page: string, @Res() res: Response) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 0) throw new NotFoundException();
    const front = this.config.get('front_host');
    res
      .type('application/xml')
      .setHeader('Cache-Control', 'public, s-maxage=3600');
    res.write(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`,
    );
    for await (const story of this.stories.publishedUrls(n, SITEMAP_PAGE)) {
      for (const locale of story.locales ?? []) {
        const loc = `${front}/${locale}/brands/${story.shopSlug}/stories/${story.slug}`;
        const alternates = (story.locales ?? [])
          .map(
            (l) =>
              `<xhtml:link rel="alternate" hreflang="${l}" href="${xmlEscape(`${front}/${l}/brands/${story.shopSlug}/stories/${story.slug}`)}"/>`,
          )
          .join('');
        const chunk = `  <url><loc>${xmlEscape(loc)}</loc><lastmod>${new Date(story.publishedAt).toISOString()}</lastmod>${alternates}</url>\n`;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); // backpressure
      }
    }
    res.end('</urlset>\n');
  }
}

function xmlEscape(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c]!,
  );
}
