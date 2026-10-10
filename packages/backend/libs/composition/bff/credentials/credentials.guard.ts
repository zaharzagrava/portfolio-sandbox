import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import {
  RequestCredentials,
  RequestWithCredentials,
} from './request-credentials';

/** Attaches the resolved `Credentials` to the request before the rate-limit interceptor reads `req.user`. */
@Injectable()
export class CredentialsGuard implements CanActivate {
  constructor(private readonly credentials: RequestCredentials) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithCredentials>();
    req.credentials = await this.credentials.resolve(
      req,
      http.getResponse<Response>(),
    );
    return true;
  }
}
