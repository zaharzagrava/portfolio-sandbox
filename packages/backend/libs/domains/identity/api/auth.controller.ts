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
import { ApiConfigService } from '@app/common/config';
import { CredentialCookies } from './credential-cookies';
import { CsrfGuard } from './guards/csrf.guard';
import { JsonOnlyGuard } from './guards/json-only.guard';
import { assertOriginAllowed } from './guards/origin.guard';
import { sessionMeta } from './request-meta';
import { PasswordResetService } from '../application/password-reset.service';
import {
  AuthUserDto,
  PasswordLoginDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
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
    private readonly passwordReset: PasswordResetService,
    private readonly cookies: CredentialCookies,
    private readonly config: ApiConfigService,
  ) {}

  @RateLimit('auth.register.ip')
  @UseGuards(JsonOnlyGuard)
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() body: RegisterDto) {
    await this.registration.register(body);
    return { status: 'accepted' as const };
  }

  // SD-28: per-IP (credential stuffing from one host) + per-account (distributed guessing of one email); the account
  // policy counts failures only and a success clears it (S50).
  @RateLimit('auth.login.ip', 'auth.login.account')
  @UseGuards(JsonOnlyGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async login(
    @Body() body: PasswordLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieMode = body.delivery === 'cookie';
    // Before any credential is checked: a login-CSRF attempt must not reach the password or set a cookie (FR-052).
    if (cookieMode) assertOriginAllowed(req, this.config);
    const result = await this.login_.login(body, sessionMeta(req));
    if (result.mfaRequired) {
      if (!cookieMode)
        return { mfaRequired: true as const, mfaToken: result.mfaToken };
      this.cookies.setChallenge(res, result.mfaToken);
      return { mfaRequired: true as const };
    }
    return cookieMode ? this.cookies.set(res, result) : credentialBody(result);
  }

  @RateLimit('auth.refresh.ip')
  @UseGuards(JsonOnlyGuard, CsrfGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const fromCookie = cookie.parse(req.headers.cookie ?? '')[REFRESH_COOKIE];
    const issued = await this.refresh_.refresh(
      body.refreshToken ?? fromCookie ?? '',
    );
    // A browser that sent no body token is a cookie session: rotate the cookies, return no token (FR-055).
    return body.refreshToken === undefined && fromCookie
      ? this.cookies.set(res, issued)
      : credentialBody(issued);
  }

  @RateLimit('auth.reset.ip')
  @UseGuards(JsonOnlyGuard)
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', NO_STORE)
  async requestPasswordReset(@Body() body: PasswordResetRequestDto) {
    await this.passwordReset.request(body.email);
    return { status: 'accepted' as const };
  }

  @RateLimit('auth.reset.confirm.ip')
  @UseGuards(JsonOnlyGuard)
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', NO_STORE)
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto) {
    await this.passwordReset.confirm(body.token, body.password);
  }

  @Firewall()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @User() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.revocation.revokeBySid(user.sessionId, 'logout');
    // Harmless for a bearer client; for a cookie session it ends the three credential cookies (FR-055).
    this.cookies.clear(res);
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
  @Get('me')
  async me(@User() user: AuthenticatedUser): Promise<AuthUserDto> {
    return this.account.profile(user.id);
  }
}
