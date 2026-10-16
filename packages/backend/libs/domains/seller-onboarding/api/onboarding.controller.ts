import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { documentUploadRequestSchema } from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { OnboardingSessionService } from '../application/onboarding-session.service';
import { OnboardingDocumentsService } from '../application/onboarding-documents.service';
import { documentNotFound } from '../domain/errors';
import { UuidParamPipe, ZodPipe } from './zod.pipes';

/** Seller side (S04 contracts/http.md): all routes need `shop.manage` of the shop in the path. */
@ApiTags('onboarding')
@Controller()
export class OnboardingController {
  constructor(
    private readonly session: OnboardingSessionService,
    private readonly documents: OnboardingDocumentsService,
  ) {}

  /** Saves one questionnaire step (validated strictly on its own; drafts live in Redis). */
  @ShopScoped('shop.manage')
  @Put('shops/:shopId/onboarding/steps/:step')
  saveStep(
    @Param('shopId') shopId: string,
    @Param('step') step: string,
    @Body() body: unknown,
  ) {
    return this.session.saveStep(shopId, step, body);
  }

  @ShopScoped('shop.manage')
  @Get('shops/:shopId/onboarding')
  get(@Param('shopId') shopId: string) {
    return this.session.view(shopId);
  }

  @ShopScoped('shop.manage')
  @HttpCode(200)
  @Post('shops/:shopId/onboarding/submit')
  submit(@Param('shopId') shopId: string, @User() user: UserRawDto) {
    return this.session.submit(shopId, user.id);
  }

  /** `201` for a new document, `200` for the same file asked for again. */
  @ShopScoped('shop.manage')
  @Post('shops/:shopId/onboarding/documents')
  async requestUpload(
    @Param('shopId') shopId: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(documentUploadRequestSchema))
    body: ReturnType<typeof documentUploadRequestSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.documents.requestUpload(shopId, user.id, body);
    res.status(result.deduplicated ? 200 : 201);
    return result;
  }

  @ShopScoped('shop.manage')
  @HttpCode(200)
  @Post('shops/:shopId/onboarding/documents/:documentId/uploaded')
  uploaded(
    @Param('shopId') shopId: string,
    @Param('documentId', new UuidParamPipe(documentNotFound))
    documentId: string,
    @User() user: UserRawDto,
  ) {
    return this.documents.uploaded(shopId, user.id, documentId);
  }
}
