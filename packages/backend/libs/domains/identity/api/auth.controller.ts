import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
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
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ApiConfigService } from '@app/common/config';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { AuthSessionService } from '../application/auth-session.service';
import { AccountService } from '../application/account.service';
import { LoginService } from '../application/login.service';
import { RefreshService } from '../application/refresh.service';
import { RegistrationService } from '../application/registration.service';
import { SessionRevocationService } from '../application/session-revocation.service';
import type { IssuedSession } from '../application/session-issuer.service';
import { TotpService } from '../application/mfa/totp.service';
import { OidcService } from '../infra/oidc/oidc.service';
import { CsrfGuard, CSRF_COOKIE } from './guards/csrf.guard';
import {
  AuthUserDto,
  MfaConfirmDto,
  MfaVerifyDto,
  PasswordLoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';

const REFRESH_COOKIE = '__Host-refresh';
const NO_STORE = 'no-store';

/** The body of a credential response: tokens and the user, never the delivery bookkeeping. */
const credentialBody = ({ delivery: _delivery, ...body }: IssuedSession) =>
  body;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly login_: LoginService,
    private readonly refresh_: RefreshService,
    private readonly revocation: SessionRevocationService,
    private readonly account: AccountService,
    private readonly sessions: AuthSessionService,
    private readonly totp: TotpService,
    private readonly oidc: OidcService,
    private readonly config: ApiConfigService,
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
    const result = await this.login_.login(body, this.meta(req));
    return result.mfaRequired
      ? { mfaRequired: true as const, mfaToken: result.mfaToken }
      : credentialBody(result);
  }

  @RateLimit('auth.login.ip')
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async verifyMfa(@Body() body: MfaVerifyDto, @Req() req: Request) {
    return credentialBody(
      await this.sessions.completeMfa(body.mfaToken, body.code, this.meta(req)),
    );
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

  @Firewall({ sensitive: true })
  @Post('mfa/enroll')
  async enrollMfa(@User() user: AuthenticatedUser) {
    return this.totp.enroll({ id: user.id, email: null });
  }

  @Firewall({ sensitive: true })
  @Post('mfa/confirm')
  async confirmMfa(
    @User() user: AuthenticatedUser,
    @Body() body: MfaConfirmDto,
  ) {
    const result = await this.totp.confirm(user.id, body.code);
    if (!result) throw new BadRequestException('Invalid code');
    return result;
  }

  @Firewall()
  @Get('me')
  async me(@User() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.account.profile(user.id);
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
    this.refreshCookies(
      res,
      await this.sessions.loginWithOidc(identity, this.meta(req)),
    );
    // Browser flow: tokens travel only in the HttpOnly cookie; the SPA calls /auth/refresh for an access token.
    res.redirect(302, `${this.config.get('front_host')}${returnTo}`);
  }

  /**
   * OIDC browser flow only until cookie delivery (US6) takes over: refresh token → `__Host-` cookie (HttpOnly, Secure,
   * Path=/, no Domain), plus a readable CSRF cookie for the double-submit header.
   */
  private refreshCookies(res: Response, tokens: IssuedSession): void {
    const maxAge = 30 * 86_400_000;
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
    res.cookie(CSRF_COOKIE, randomBytes(16).toString('base64url'), {
      httpOnly: false,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  }

  /** Relative paths only - prevents open redirects through ?returnTo=https://evil.example. */
  private safeReturnTo(returnTo?: string): string {
    return returnTo && /^\/(?!\/)[\w\-./?=&%]*$/.test(returnTo)
      ? returnTo
      : '/';
  }

  /** Device and address of the session; the address is the platform's trusted-proxy result, never a header (FR-014). */
  private meta(req: Request & { clientIp?: string }) {
    return {
      device: String(req.headers['user-agent'] ?? '').slice(0, 200),
      ip: req.clientIp,
    };
  }
}
