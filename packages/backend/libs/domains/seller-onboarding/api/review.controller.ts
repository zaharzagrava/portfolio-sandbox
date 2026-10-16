import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  reviewQueueQuerySchema,
  reviewResolveRequestSchema,
  type ReviewResolveRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ReviewService } from '../application/review.service';
import { validationFailed } from '../domain/errors';
import { ReviewerRoleGuard } from './reviewer-role.guard';
import { UuidParamPipe, ZodPipe } from './zod.pipes';

type QueueQuery = ReturnType<typeof reviewQueueQuerySchema.parse>;

/**
 * Moderator side (S04 contracts/http.md): platform roles `ADMIN` and `MODERATOR`, on sensitive routes (a revoked session
 * is refused at once). The conflict-of-interest check and the audit records are the service's.
 */
@ApiTags('onboarding-review')
@Controller('admin/onboarding/reviews')
export class OnboardingReviewController {
  constructor(private readonly reviews: ReviewService) {}

  // decorators apply bottom-up: Firewall (authentication, sensitive session) registers its guards first
  @UseGuards(ReviewerRoleGuard)
  @Firewall({ sensitive: true })
  @Get()
  queue(
    @User() user: UserRawDto,
    @Query(new ZodPipe(reviewQueueQuerySchema)) query: QueueQuery,
  ) {
    return this.reviews.queue(user.id, query);
  }

  @UseGuards(ReviewerRoleGuard)
  @Firewall({ sensitive: true })
  @HttpCode(200)
  @Post(':taskId/resolve')
  resolve(
    @Param(
      'taskId',
      new UuidParamPipe(() =>
        validationFailed([{ path: 'taskId', message: 'Must be a UUID' }]),
      ),
    )
    taskId: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(reviewResolveRequestSchema)) body: ReviewResolveRequest,
  ) {
    return this.reviews.resolve(taskId, user.id, body);
  }
}
