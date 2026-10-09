import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService } from '../../application/auth.service';
import { extractAuthToken } from './extract-auth-token';

@Injectable()
export class UserAuthOptionalGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractAuthToken(request);

    try {
      request.user = token
        ? await this.authService.userAuthentication(token)
        : null;
    } catch {
      request.user = null;
    }

    return true;
  }
}
