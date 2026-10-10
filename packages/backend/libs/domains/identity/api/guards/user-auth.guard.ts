import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Domain_InvalidTokenError } from '../../domain/errors';
import { TokenAuthService } from '../../application/token-auth.service';
import { extractAuthToken } from './extract-auth-token';

/** Authenticates from the token alone; every failure is the same `401 invalid_token` (FR-022, AS-24). */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractAuthToken(request);
    if (!token) throw new Domain_InvalidTokenError('missing');
    request.user = await this.tokens.authenticate(token);
    return true;
  }
}
