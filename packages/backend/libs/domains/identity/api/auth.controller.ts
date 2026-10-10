import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as cookie from 'cookie';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import { RateLimit } from '@app/infrastructure/rate-limit';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { AccountService } from '../application/account.service';
import { LoginService } from '../application/login.service';
import { RefreshService } from '../application/refresh.service';
import { RegistrationService } from '../application/registration.service';
import { SessionRevocationService } from '../application/session-revocation.service';
import type { IssuedSession } from '../application/session-issuer.service';
import { CsrfGuard } from './guards/csrf.guard';
import { sessionMeta } from './request-meta';
import {
  AuthUserDto,
  PasswordLoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';

const REFRESH_COOKIE = '__Host-refresh';
const NO_STORE = 'no-store';

/** The body of a credential response: tokens and the user, never the delivery bookkeeping. */
const credentialBody = ({ delivery: _delivery, ...body }: IssuedSession) =>
  body;

/** Registration, password login, refresh and the signed-in user's sessions. MFA is `MfaController`, OIDC `OidcController`. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly login_: LoginService,
    private readonly refresh_: RefreshService,
    private readonly revocation: SessionRevocationService,
    private readonly account: AccountService,
  ) {}

  @RateLimit('auth.register.ip')
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() body: RegisterDto) {
    await this.registration.register(body);
    return { status: 'accepted' as const };
  }

  // SD-28: per-IP (credential stuffing from one host) + per-account (distributed guessing of one email); the account
  // policy counts failures only and a success clears it (S50).
  @RateLimit('auth.login.ip', 'auth.login.account')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async login(@Body() body: PasswordLoginDto, @Req() req: Request) {
    const result = await this.login_.login(body, sessionMeta(req));
    return result.mfaRequired
      ? { mfaRequired: true as const, mfaToken: result.mfaToken }
      : credentialBody(result);
  }

  @RateLimit('auth.refresh.ip')
  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async refresh(@Body() body: RefreshDto, @Req() req: Request) {
    const token =
      body.refreshToken ??
      cookie.parse(req.headers.cookie ?? '')[REFRESH_COOKIE] ??
      '';
    return credentialBody(await this.refresh_.refresh(token));
  }

  @Firewall()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @User() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.revocation.revokeBySid(user.sessionId, 'logout');
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @Firewall({ sensitive: true })
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(@User() user: AuthenticatedUser) {
    return {
      revokedSessions: await this.revocation.revokeAllForUser(
        user.id,
        'logout_all',
      ),
    };
  }

  @Firewall()
  @Get('sessions')
  async listSessions(@User() user: AuthenticatedUser) {
    return (await this.account.activeSessions(user.id)).map((s) => ({
      sessionId: s.sid,
      device: s.device ?? null,
      ip: s.ip ?? null,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt ?? null,
      current: s.sid === user.sessionId,
    }));
  }

  @Firewall()
  @Get('me')
  async me(@User() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.account.profile(user.id);
  }
}
