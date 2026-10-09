import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as cookie from 'cookie';
import { randomBytes } from 'node:crypto';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import { UserRawDto } from './users.dto';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import {
  AuthSessionService,
  SessionTokens,
} from '../application/auth-session.service';
import { SessionStore } from '../infra/sessions/session-store.service';
import { TotpService } from '../application/mfa/totp.service';
import { OidcService } from '../infra/oidc/oidc.service';
import { CsrfGuard, CSRF_COOKIE } from './guards/csrf.guard';
import { SessionNotRevokedGuard } from './guards/session-not-revoked.guard';
import {
  AuthUserDto,
  MfaConfirmDto,
  MfaVerifyDto,
  PasswordLoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';

const REFRESH_COOKIE = '__Host-refresh';

type SessionUser = UserRawDto & { sessionId?: string };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: AuthSessionService,
    private readonly sessionStore: SessionStore,
    private readonly totp: TotpService,
    private readonly oidc: OidcService,
    private readonly config: ApiConfigService,
  ) {}

  @RateLimit('auth.login.ip')
  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withCookies(
      res,
      await this.sessions.register(body, this.meta(req)),
    );
  }

  // SD-28: per-IP (credential stuffing from one host) + per-account (distributed guessing of one email).
  @RateLimit('auth.login.ip', 'auth.login.account')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: PasswordLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sessions.login(body, this.meta(req));
    return result.mfaRequired ? result : this.withCookies(res, result);
  }

  @RateLimit('auth.login.ip')
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body() body: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withCookies(
      res,
      await this.sessions.completeMfa(body.mfaToken, body.code, this.meta(req)),
    );
  }

  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token =
      body.refreshToken ??
      cookie.parse(req.headers.cookie ?? '')[REFRESH_COOKIE] ??
      '';
    return this.withCookies(res, await this.sessions.refresh(token));
  }

  @Firewall()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @User() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (user.sessionId) await this.sessions.logout(user.sessionId);
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @UseGuards(SessionNotRevokedGuard) // listed above @Firewall(): decorators apply bottom-up, auth must run first
  @Firewall()
  @Post('logout-all')
  async logoutAll(@User() user: SessionUser) {
    return { revokedSessions: await this.sessions.logoutAll(user.id) };
  }

  @Firewall()
  @Get('sessions')
  async listSessions(@User() user: SessionUser) {
    return (await this.sessionStore.listForUser(user.id)).map((s) => ({
      ...s,
      current: s.sid === user.sessionId,
    }));
  }

  @UseGuards(SessionNotRevokedGuard) // listed above @Firewall(): decorators apply bottom-up, auth must run first
  @Firewall()
  @Post('mfa/enroll')
  async enrollMfa(@User() user: SessionUser) {
    return this.totp.enroll(user);
  }

  @UseGuards(SessionNotRevokedGuard) // listed above @Firewall(): decorators apply bottom-up, auth must run first
  @Firewall()
  @Post('mfa/confirm')
  async confirmMfa(@User() user: SessionUser, @Body() body: MfaConfirmDto) {
    const result = await this.totp.confirm(user.id, body.code);
    if (!result) throw new BadRequestException('Invalid code');
    return result;
  }

  @Firewall()
  @Get('me')
  async me(@User() user: UserRawDto): Promise<AuthUserDto> {
    return { id: user.id, email: user.email, role: user.role };
  }

  @RateLimit('auth.login.ip')
  @Get('oidc/:provider/start')
  async oidcStart(
    @Param('provider') provider: string,
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    res.redirect(
      302,
      await this.oidc.start(provider, this.safeReturnTo(returnTo)),
    );
  }

  @Get('oidc/:provider/callback')
  async oidcCallback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const base =
      this.config.get('auth_redirect_base_url') ??
      this.config.get('backend_host');
    const { identity, returnTo } = await this.oidc.callback(
      provider,
      new URL(req.originalUrl, base),
    );
    this.withCookies(
      res,
      await this.sessions.loginWithOidc(identity, this.meta(req)),
    );
    // Browser flow: tokens travel only in the HttpOnly cookie; the SPA calls /auth/refresh for an access token.
    res.redirect(302, `${this.config.get('front_host')}${returnTo}`);
  }

  /**
   * Refresh token → `__Host-` cookie (HttpOnly, Secure, Path=/, no Domain: can't
   * be set or read by subdomains or JS), plus a readable CSRF cookie for the
   * double-submit header. Body keeps the refresh token for non-browser clients.
   */
  private withCookies(res: Response, tokens: SessionTokens): SessionTokens {
    // Always Secure: `__Host-` cookies are rejected without it, and browsers treat http://localhost as a secure origin.
    const secure = true;
    const maxAge =
      (this.config.get('refresh_token_ttl_days') ?? 30) * 86_400_000;
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
    res.cookie(CSRF_COOKIE, randomBytes(16).toString('base64url'), {
      httpOnly: false,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
    return tokens;
  }

  /** Relative paths only - prevents open redirects through ?returnTo=https://evil.example. */
  private safeReturnTo(returnTo?: string): string {
    return returnTo && /^\/(?!\/)[\w\-./?=&%]*$/.test(returnTo)
      ? returnTo
      : '/';
  }

  private meta(req: Request) {
    return {
      device: String(req.headers['user-agent'] ?? '').slice(0, 200),
      ip: (req.headers['cf-connecting-ip'] as string) ?? req.ip,
    };
  }
}
