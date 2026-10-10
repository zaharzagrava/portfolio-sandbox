import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Domain_InvalidTokenError } from '../../domain/errors';
import { TokenAuthService } from '../../application/token-auth.service';
import { extractAuthToken } from './extract-auth-token';

/** Anonymous-allowed routes: a bad token degrades to "no user", with the reason in the debug log (A23). */
@Injectable()
export class UserAuthOptionalGuard implements CanActivate {
  private readonly logger = new Logger(UserAuthOptionalGuard.name);

  constructor(private readonly tokens: TokenAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractAuthToken(request);
    try {
      request.user = token ? await this.tokens.authenticate(token) : null;
    } catch (error) {
      request.user = null;
      this.logger.debug(
        `optional authentication ignored a bad token: ${
          error instanceof Domain_InvalidTokenError ? error.reason : 'error'
        }`,
      );
    }
    return true;
  }
}
