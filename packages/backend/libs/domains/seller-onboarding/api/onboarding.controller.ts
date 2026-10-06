import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Firewall, User, UserRawDto, Role } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { OnboardingSessionService } from '../application/onboarding-session.service';
import { ACCEPTED_TYPES, OnboardingDocumentsService } from '../application/onboarding-documents.service';
import { ReviewService } from '../application/review.service';
import type { DocumentKind, StepName } from '../domain/questionnaire';

export class RequestDocumentUploadDto {
  @ApiProperty({ enum: ['BUSINESS_REGISTRATION', 'VAT_CERTIFICATE', 'BANK_STATEMENT'] }) @IsIn(['BUSINESS_REGISTRATION', 'VAT_CERTIFICATE', 'BANK_STATEMENT']) kind: DocumentKind;
  @ApiProperty() @Matches(/^[0-9a-f]{64}$/) sha256: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10 * 1024 * 1024) size: number;
  @ApiProperty({ enum: Object.keys(ACCEPTED_TYPES) }) @IsIn(Object.keys(ACCEPTED_TYPES)) contentType: string;
}

export class ResolveReviewDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) @IsIn(['APPROVE', 'REJECT']) decision: 'APPROVE' | 'REJECT';
  @ApiPropertyOptional({ example: { iban: 'DE89370400440532013000' } }) @IsOptional() @IsObject() corrections?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 500) reason?: string;
}

@ApiTags('onboarding')
@Controller()
export class OnboardingController {
  constructor(
    private readonly session: OnboardingSessionService,
    private readonly documents: OnboardingDocumentsService,
  ) {}

  /** Save one questionnaire step (validated on its own; drafts live in Redis). */
  @ShopScoped('shop.manage')
  @Put('shops/:shopId/onboarding/steps/:step')
  saveStep(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('step') step: StepName, @Body() body: unknown) {
    return this.session.saveStep(shopId, step, body);
  }

  @ShopScoped('shop.manage')
  @Get('shops/:shopId/onboarding')
  async get(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return { ...(await this.session.get(shopId)), documents: await this.documents.list(shopId) };
  }

  @ShopScoped('shop.manage')
  @HttpCode(200)
  @Post('shops/:shopId/onboarding/submit')
  submit(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto) {
    return this.session.submit(shopId, user.id);
  }

  @ShopScoped('shop.manage')
  @Post('shops/:shopId/onboarding/documents')
  requestUpload(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: RequestDocumentUploadDto) {
    return this.documents.requestUpload(shopId, body.kind, body.sha256, body.size, body.contentType);
  }

  @ShopScoped('shop.manage')
  @HttpCode(200)
  @Post('shops/:shopId/onboarding/documents/:documentId/uploaded')
  uploaded(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.documents.uploaded(shopId, documentId);
  }
}

@ApiTags('onboarding-review')
@Controller('admin/onboarding/reviews')
export class OnboardingReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Firewall({ roles: [Role.ADMIN, Role.MODERATOR] })
  @Get()
  queue(@Query('limit') limit?: string) {
    return this.reviews.queue(Math.min(200, Math.max(1, Number(limit ?? 50) || 50)));
  }

  @Firewall({ roles: [Role.ADMIN, Role.MODERATOR] })
  @HttpCode(200)
  @Post(':taskId/resolve')
  resolve(@Param('taskId', ParseUUIDPipe) taskId: string, @User() user: UserRawDto, @Body() body: ResolveReviewDto) {
    return this.reviews.resolve(taskId, user.id, body);
  }
}
