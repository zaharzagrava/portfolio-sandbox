import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  StreamAuthenticatorRegistry,
  StreamInvalidCredentialError,
  type StreamPrincipal,
} from './stream-authenticator';
import { StreamUnauthenticatedError } from './stream-errors';

export const STREAM_PRINCIPAL = Symbol.for('realtime.stream.principal');

/**
 * Anonymous allowed, but a credential that is presented and does not verify is `401` even for public topics (FR-010).
 * Runs before the rate limit so the limiter keys on the user (`req.user.id`), not only on the address.
 */
@Injectable()
export class StreamAuthGuard implements CanActivate {
  constructor(private readonly authenticator: StreamAuthenticatorRegistry) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    let principal: StreamPrincipal | null;
    try {
      principal = await this.authenticator.authenticate(request);
    } catch (error) {
      if (error instanceof StreamInvalidCredentialError)
        throw new StreamUnauthenticatedError();
      throw error;
    }
    request[STREAM_PRINCIPAL] = principal;
    if (principal) request.user = { id: principal.userId };
    return true;
  }
}
