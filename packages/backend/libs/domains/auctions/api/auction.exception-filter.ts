import { ArgumentsHost, Catch } from '@nestjs/common';
import { AppError } from '@app/common/errors/error.types';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import {
  AuctionNotFoundError,
  BidUnavailableError,
} from '../domain/auction-errors';

type Req = {
  method?: string;
  path?: string;
  url?: string;
  params?: { auctionId?: string };
};

/**
 * Maps what the platform pieces say onto this capability's stable codes (S21 contracts/http.md); domain errors are
 * already `AppError`s with their own `code`, so controllers never branch on them (II.1, A13):
 *
 *  - a limiter store failure on the bid route (the policy is fail closed) is `503 bid_unavailable` + `Retry-After: 2`
 *    (FR-018, AS-21), so a client sees one code for every "bidding is paused" case;
 *  - the shop gate's hidden `404 shop_not_found` on a route that names an auction is the same `auction_not_found`
 *    document as a missing or foreign auction, so the seller cannot tell "not your shop" from "not your auction" (AS-07).
 *
 * Everything else goes to the platform filter unchanged.
 */
@Catch()
export class AuctionExceptionFilter extends AllExceptionsFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<Req>();
    if (exception instanceof AppError) {
      const path = request.path ?? request.url ?? '';
      if (
        exception.code === 'rate_limiter_unavailable' &&
        request.method === 'POST' &&
        /\/bids\/?(\?.*)?$/.test(path)
      )
        return super.catch(new BidUnavailableError(), host);
      if (
        exception.code === 'shop_not_found' &&
        request.params?.auctionId !== undefined
      )
        return super.catch(new AuctionNotFoundError(), host);
    }
    return super.catch(exception, host);
  }
}
