import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  Draft,
  DraftConnect,
  DraftPage,
  DraftPublishResult,
  DraftVersion,
  DraftVersionDetail,
  DraftVersionPage,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { DraftPublishService } from '../application/draft-publish.service';
import { DraftVersionsService } from '../application/draft-versions.service';
import { DraftsService } from '../application/drafts.service';
import { DraftIdPipe } from './draft-id.pipe';

/** `Idempotency-Key` of a publish: 1 to 128 printable characters; the facility keeps a key for 24 hours. */
const PUBLISH_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Member routes of a shop's listing drafts (S06 `contracts/http.md`). Each method is: guard (member, permission, shop
 * status) -> one service call -> a view. Bodies are validated by the services with the contract schemas.
 */
@ApiTags('drafts')
@Controller('shops/:shopId/drafts')
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly versions: DraftVersionsService,
    private readonly publisher: DraftPublishService,
  ) {}

  @ShopScoped('products.write')
  @RateLimit('catalog.draft-write.shop')
  @Post()
  create(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<Draft> {
    return this.drafts.create(shopId, user.id, body);
  }

  @ShopScoped('products.read')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<DraftPage> {
    return this.drafts.list(shopId, query);
  }

  /** `{ url: "wss://collab-7.../collab/<id>", ticket, canWrite, expiresAt }`: the editor opens the socket with `?ticket=`. */
  @ShopScoped('products.read')
  @RateLimit('catalog.draft-connect.user')
  @HttpCode(200)
  @Post(':draftId/connect')
  connect(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
    @User() user: UserRawDto,
  ): Promise<DraftConnect> {
    return this.drafts.connect(shopId, draftId, user.id);
  }

  @ShopScoped('products.write')
  @RateLimit('catalog.draft-write.shop')
  @HttpCode(200)
  @Post(':draftId/archive')
  archive(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
  ): Promise<Draft> {
    return this.drafts.archive(shopId, draftId);
  }

  @ShopScoped('products.read')
  @Get(':draftId/versions')
  listVersions(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<DraftVersionPage> {
    return this.versions.list(shopId, draftId, query);
  }

  @ShopScoped('products.read')
  @Get(':draftId/versions/:versionId')
  getVersion(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
    @Param('versionId', DraftIdPipe) versionId: string,
  ): Promise<DraftVersionDetail> {
    return this.versions.get(shopId, draftId, versionId);
  }

  @ShopScoped('products.write')
  @RateLimit('catalog.draft-write.shop')
  @Post(':draftId/versions')
  createVersion(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<DraftVersion> {
    return this.versions.create(shopId, draftId, user.id, body);
  }

  /**
   * Publishes the draft as a new product or a revision of its product. The `Idempotency-Key` is scoped to the shop and the
   * draft, kept for 24 hours; a replay returns the stored answer, an in-flight twin is `409 request_in_flight`.
   */
  @ShopScoped('products.write')
  @RateLimit('catalog.draft-publish.shop')
  @Idempotent({
    ttlSeconds: 24 * 3600,
    scope: (req) =>
      `drafts.publish:${String(req.params.shopId).toLowerCase()}:${String(req.params.draftId).toLowerCase()}`,
    wire: {
      keyPattern: PUBLISH_KEY,
      codes: { inFlight: 'request_in_flight' },
    },
  })
  @HttpCode(200)
  @Post(':draftId/publish')
  publish(
    @Param('shopId') shopId: string,
    @Param('draftId', DraftIdPipe) draftId: string,
    @User() user: UserRawDto,
    @Body() body: unknown,
  ): Promise<DraftPublishResult> {
    return this.publisher.publish(shopId, draftId, user.id, body);
  }
}
