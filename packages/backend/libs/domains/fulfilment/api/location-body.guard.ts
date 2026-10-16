import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { MAX_LOCATION_BODY_BYTES } from '@marketplace-sandbox/contracts';
import { PayloadTooLargeError } from '../domain/delivery-errors';

interface BodyRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}

/**
 * The 32 KB limit of a location batch (S20 FR-005, AS-06): `413 payload_too_large` before the body is validated or
 * anything is stored. The platform parser (1 MiB) has read the body and kept its exact bytes in `rawBody`; the declared
 * length is checked first so an honest client is refused without looking at the bytes.
 */
@Injectable()
export class LocationBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<BodyRequest>();
    const declared = Number(req.headers['content-length']);
    if (
      (Number.isFinite(declared) && declared > MAX_LOCATION_BODY_BYTES) ||
      (req.rawBody?.length ?? 0) > MAX_LOCATION_BODY_BYTES
    )
      throw new PayloadTooLargeError();
    return true;
  }
}
