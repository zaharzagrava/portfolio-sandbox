import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  BFF_SESSION_LIMITS,
  sessionLoginRequestSchema,
  sessionMfaRequestSchema,
  type MfaRequiredResponse,
  type SessionLoginRequest,
  type SessionMfaRequest,
  type SessionResponse,
} from '@marketplace-sandbox/contracts';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { BffProblem } from '../problem';
import '../rate-limit-policies';
import { ZodPipe } from '../zod-pipe';
import { AmbiguityGuard, CsrfGuard, OriginGuard } from './csrf-origin.guard';
import { SessionService } from './session.service';

/** Rejects a body that is not JSON (415) or larger than 16 KiB (413) before anything is parsed or relayed. */
@Injectable()
export class JsonBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    if (!req.is('application/json'))
      throw new BffProblem('unsupported_media_type');
    const size =
      req.rawBody?.length ?? Number(req.headers['content-length'] ?? 0);
    if (size > BFF_SESSION_LIMITS.bodyBytes)
      throw new BffProblem('payload_too_large');
    return true;
  }
}

/** Browser session endpoints (token handler): every answer is `no-store`. */
@ApiTags('bff')
@Controller('bff/session')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @UseGuards(OriginGuard, JsonBodyGuard)
  @RateLimit('bff.session.login.ip')
  @HttpCode(200)
  @Post()
  login(
    @Body(new ZodPipe(sessionLoginRequestSchema)) body: SessionLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.sessions.login(body, req, res);
  }

  @UseGuards(OriginGuard, JsonBodyGuard)
  @RateLimit('bff.session.login.ip')
  @HttpCode(200)
  @Post('mfa')
  mfa(
    @Body(new ZodPipe(sessionMfaRequestSchema)) body: SessionMfaRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.sessions.verifyMfa(body, req, res);
  }

  @UseGuards(AmbiguityGuard)
  @Get()
  current(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.sessions.current(req, res);
  }

  @UseGuards(CsrfGuard)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    await this.sessions.logout(req, res);
  }
}
