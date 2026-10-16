import { Inject, Injectable } from '@nestjs/common';
import type { PublicStoryDto } from '@marketplace-sandbox/contracts';
import {
  draftNotFound,
  storyNotFound,
  validationFailed,
} from '../domain/errors';
import { isLocale } from '../domain/locale-chain';
import {
  DRAFT_REPOSITORY,
  PREVIEW_SIGNER,
  STORY_REPOSITORY,
  type DraftRepository,
  type PreviewSigner,
  type StoryRepository,
} from '../domain/ports';
import { PublicReadService } from './public-read.service';
import { StoryWriteLimit } from './story-limits';

/** Signed previews of a draft (S27 FR-040, FR-041). */
@Injectable()
export class PreviewService {
  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(PREVIEW_SIGNER) private readonly signer: PreviewSigner,
    private readonly reads: PublicReadService,
    private readonly writes: StoryWriteLimit,
  ) {}

  /** Mints a grant for one locale's draft: bound to the story, the shop and the locale. */
  async mint(
    shopId: string,
    storyId: string,
    locale: string,
  ): Promise<{ token: string; expiresAt: string }> {
    if (!isLocale(locale))
      throw validationFailed([{ field: 'locale', code: 'invalid' }]);
    await this.writes.take(shopId);
    if (!(await this.stories.find(shopId, storyId))) throw storyNotFound();
    if (!(await this.drafts.find(shopId, storyId, locale)))
      throw draftNotFound();
    const grant = this.signer.sign({ storyId, shopId, locale });
    return { token: grant.token, expiresAt: grant.expiresAt.toISOString() };
  }

  /** Any invalid, expired or mis-addressed token is the same `404`, whatever the reason. */
  async read(token: string | undefined): Promise<PublicStoryDto> {
    const claims = token ? this.signer.verify(token) : null;
    if (!claims) throw storyNotFound();
    return this.reads.preview(claims);
  }
}
