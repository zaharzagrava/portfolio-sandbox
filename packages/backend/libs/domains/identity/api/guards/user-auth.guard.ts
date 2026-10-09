import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../../application/auth.service';
import { extractAuthToken } from './extract-auth-token';

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(private authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractAuthToken(request);

    if (!token) {
      throw new UnauthorizedException('No auth token provided');
    }

    request.user = await this.authService.userAuthentication(token);

    return true;
  }
}
