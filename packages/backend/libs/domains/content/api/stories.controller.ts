import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  previewTokenRequestSchema,
  storyPublishRequestSchema,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { ShopScoped } from '@app/domains/tenancy';
import { DraftsService } from '../application/drafts.service';
import { LifecycleService } from '../application/lifecycle.service';
import { PreviewService } from '../application/preview.service';
import { PublishService } from '../application/publish.service';
import { ScheduleService } from '../application/schedule.service';
import { StoriesService } from '../application/stories.service';
import { validationFailed, versionNotFound } from '../domain/errors';
import { LIMITS } from '../domain/limits';
import { STORY_STATUSES, type StoryStatus } from '../domain/story-status';
import {
  IntQueryPipe,
  LocaleParamPipe,
  UuidParamPipe,
  VersionParamPipe,
  ZodPipe,
} from './pipes';

/** Key scope of a publish: per shop (S27 FR-013). */
const publishScope = (req: Request) =>
  `shop:${String(req.params.shopId).toLowerCase()}`;

const storyId = () => Param('storyId', new UuidParamPipe('storyId'));
const locale = () => Param('locale', new LocaleParamPipe());
const version = () => Param('version', new VersionParamPipe(versionNotFound));

type PublishBody = ReturnType<typeof storyPublishRequestSchema.parse>;
type PreviewBody = ReturnType<typeof previewTokenRequestSchema.parse>;

/** Staff routes (S27 "Provides"): the list needs `products.read`, everything else `products.write` of the shop in the path. */
@ApiTags('stories')
@Controller()
export class StoriesController {
  constructor(
    private readonly stories: StoriesService,
    private readonly drafts: DraftsService,
    private readonly publisher: PublishService,
    private readonly schedules: ScheduleService,
    private readonly lifecycle: LifecycleService,
    private readonly previews: PreviewService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/stories')
  create(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ) {
    return this.stories.create(shopId, user.id, body);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/stories')
  list(
    @Param('shopId') shopId: string,
    @Query('status') status: string | undefined,
    @Query(
      'limit',
      new IntQueryPipe('limit', 1, LIMITS.listMax, LIMITS.listDefault),
    )
    limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    if (
      status !== undefined &&
      !(STORY_STATUSES as readonly string[]).includes(status)
    )
      throw validationFailed([{ field: 'status', code: 'invalid' }]);
    return this.stories.list(shopId, {
      status: status as StoryStatus | undefined,
      limit,
      cursor: cursor === '' ? undefined : cursor,
    });
  }

  @ShopScoped('products.write')
  @Get('shops/:shopId/stories/:storyId')
  detail(@Param('shopId') shopId: string, @storyId() id: string) {
    return this.stories.detail(shopId, id);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/stories/:storyId/drafts/:locale')
  saveDraft(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @locale() draftLocale: string,
    @Body() body: unknown,
  ) {
    return this.drafts.save(shopId, id, draftLocale, body);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/stories/:storyId/drafts/:locale')
  async deleteDraft(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @locale() draftLocale: string,
    @Query(
      'expectedRevision',
      new IntQueryPipe('expectedRevision', 0, 1_000_000_000),
    )
    expectedRevision: number,
  ): Promise<void> {
    await this.drafts.remove(shopId, id, draftLocale, expectedRevision);
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Idempotent({ ttlSeconds: LIMITS.idempotencyTtlSec, scope: publishScope })
  @Post('shops/:shopId/stories/:storyId/publish')
  publish(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(storyPublishRequestSchema)) body: PublishBody,
  ) {
    return body.at === undefined
      ? this.publisher.publish(shopId, id, user.id, body.expectedVersion)
      : this.schedules.schedule(
          shopId,
          id,
          user.id,
          body.expectedVersion,
          body.at,
        );
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/stories/:storyId/schedule')
  async cancelSchedule(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @User() user: UserRawDto,
  ): Promise<void> {
    await this.schedules.cancel(shopId, id, user.id);
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/stories/:storyId/archive')
  archive(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @User() user: UserRawDto,
  ) {
    return this.lifecycle.archive(shopId, id, user.id);
  }

  @ShopScoped('products.write')
  @Get('shops/:shopId/stories/:storyId/versions')
  versions(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @Query(
      'limit',
      new IntQueryPipe('limit', 1, LIMITS.listMax, LIMITS.listDefault),
    )
    limit: number,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.lifecycle.listVersions(shopId, id, {
      limit,
      cursor: cursor === '' ? undefined : cursor,
    });
  }

  @ShopScoped('products.write')
  @Get('shops/:shopId/stories/:storyId/versions/:version')
  versionDetail(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @version() number: number,
  ) {
    return this.lifecycle.version(shopId, id, number);
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/stories/:storyId/versions/:version/restore')
  restore(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @version() number: number,
  ) {
    return this.lifecycle.restore(shopId, id, number);
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/stories/:storyId/preview-token')
  previewToken(
    @Param('shopId') shopId: string,
    @storyId() id: string,
    @Body(new ZodPipe(previewTokenRequestSchema)) body: PreviewBody,
  ) {
    return this.previews.mint(shopId, id, body.locale);
  }
}
