import { Inject, Injectable } from '@nestjs/common';
import type { PublicStoryDto } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { storyEtag } from '../domain/etag';
import { storyNotFound, validationFailed } from '../domain/errors';
import { isLocale, isRequestLocale, localeChain } from '../domain/locale-chain';
import {
  PUBLISHED_STORY_READER,
  READ_MODEL,
  SHOP_COPY_REPOSITORY,
  STORY_REPOSITORY,
  DRAFT_REPOSITORY,
  type DraftRepository,
  type PublishedStoryReader,
  type ReadModel,
  type ShopCopyRepository,
  type StoryRepository,
} from '../domain/ports';
import { isSlug } from '../domain/story-input';
import { alternatesFor, storyUrl } from '../domain/sitemap-xml';

const SHOP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface ServedStory {
  dto: PublicStoryDto;
  etag: string;
  tag: string;
}

/**
 * The anonymous read (S27 FR-020 to FR-025) and the preview read (FR-041). The public story comes from the origin read
 * model of the published version (one durable fill per story at a time), the locale resolves through the chain, and a
 * story that is not public is one indistinguishable `404`. Cache headers belong to the controller; the tag and ETag
 * are decided here.
 */
@Injectable()
export class PublicReadService {
  constructor(
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(PUBLISHED_STORY_READER)
    private readonly reader: PublishedStoryReader,
    @Inject(SHOP_COPY_REPOSITORY) private readonly copies: ShopCopyRepository,
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    private readonly config: ApiConfigService,
  ) {}

  async get(
    shopSlug: string,
    slug: string,
    requestedLocale: string,
  ): Promise<ServedStory> {
    if (!isRequestLocale(requestedLocale))
      throw validationFailed([{ field: 'locale', code: 'invalid' }]);
    if (!SHOP_SLUG.test(shopSlug) || !isSlug(slug)) throw storyNotFound();
    const snapshot = await this.readModel.getOrLoad(shopSlug, slug, () =>
      this.reader.load(shopSlug, slug),
    );
    if (!snapshot) throw storyNotFound();
    const locales = Object.keys(snapshot.locales).sort();
    const served = localeChain(
      requestedLocale,
      locales,
      snapshot.defaultLocale,
    );
    if (!served) throw storyNotFound();
    const content = snapshot.locales[served];
    const front = this.front();
    return {
      dto: {
        id: snapshot.storyId,
        shopId: snapshot.shopId,
        slug: snapshot.slug,
        version: snapshot.version,
        locale: served,
        title: content.title,
        blocks: content.blocks,
        seo: content.seo,
        canonical: storyUrl(front, served, snapshot.shopSlug, snapshot.slug),
        alternates: alternatesFor(
          front,
          snapshot.shopSlug,
          snapshot.slug,
          locales,
          snapshot.defaultLocale,
        ),
        publishedAt: snapshot.publishedAt,
        preview: false,
      },
      etag: storyEtag(snapshot.storyId, snapshot.version, served),
      tag: `story:${snapshot.storyId},shop:${snapshot.shopId}`,
    };
  }

  /** The current draft of one locale in the public shape; any problem is the same `404`. */
  async preview(claims: {
    storyId: string;
    shopId: string;
    locale: string;
  }): Promise<PublicStoryDto> {
    if (!isLocale(claims.locale)) throw storyNotFound();
    const copy = await this.copies.find(claims.shopId);
    if (!copy?.slug || copy.status !== 'ACTIVE') throw storyNotFound();
    const story = await this.stories.find(claims.shopId, claims.storyId);
    if (!story) throw storyNotFound();
    const draft = await this.drafts.find(
      claims.shopId,
      claims.storyId,
      claims.locale,
    );
    if (!draft) throw storyNotFound();
    return {
      id: story.id,
      shopId: story.shopId,
      slug: story.slug,
      version: null,
      locale: draft.locale,
      title: draft.title,
      blocks: draft.blocks,
      seo: draft.seo,
      canonical: storyUrl(this.front(), draft.locale, copy.slug, story.slug),
      alternates: [],
      publishedAt: null,
      preview: true,
    };
  }

  private front(): string {
    return this.config.get('front_host') ?? '';
  }
}
