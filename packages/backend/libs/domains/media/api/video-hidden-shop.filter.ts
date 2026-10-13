import { ArgumentsHost, Catch } from '@nestjs/common';
import { AppError } from '@app/common/errors/error.types';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { videoNotFound } from '../domain/video-errors';

/**
 * The shop gate (S03) answers a non-member with its own hidden `404 shop_not_found`. On a route that names a video
 * (`:id`) the seller must not be able to tell "not your shop" from "not your video" from "no such video" (S30 AS-42,
 * AS-48): all three are the same `video_not_found` document. Routes without a video id (start, list) keep the shop
 * gate's own answer. Everything else goes to the platform filter unchanged.
 */
@Catch()
export class VideoHiddenShopFilter extends AllExceptionsFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    const request = host
      .switchToHttp()
      .getRequest<{ params?: { id?: string } }>();
    if (
      request.params?.id !== undefined &&
      exception instanceof AppError &&
      exception.code === 'shop_not_found'
    )
      return super.catch(videoNotFound(), host);
    return super.catch(exception, host);
  }
}
