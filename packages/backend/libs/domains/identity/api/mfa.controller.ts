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
import { ApiConfigService } from '@app/common/config';
import { RateLimit } from '@app/infrastructure/rate-limit';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { Domain_InvalidMfaChallengeError } from '../domain/errors';
import { MfaLoginService } from '../application/mfa-login.service';
import { SecondFactorService } from '../application/second-factor.service';
import { CredentialCookies, MFA_CHALLENGE_COOKIE } from './credential-cookies';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import { assertOriginAllowed } from './guards/origin.guard';
import { JsonOnlyGuard } from './guards/json-only.guard';
import { sessionMeta } from './request-meta';
import { MfaConfirmDto, MfaVerifyDto } from './auth.dto';

const NO_STORE = 'no-store';

/**
 * The second factor. Authentication and the per-IP throttle run before the body is validated; the controller builds
 * no token (sessions are `SessionIssuer`'s) and writes cookies only through `CredentialCookies`.
 */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly factor: SecondFactorService,
    private readonly login: MfaLoginService,
    private readonly cookies: CredentialCookies,
    private readonly config: ApiConfigService,
  ) {}

  @Firewall({ sensitive: true })
  @Get()
  @Header('Cache-Control', NO_STORE)
  status(@User() user: AuthenticatedUser) {
    return this.factor.status(user.id);
  }

  @Firewall({ sensitive: true })
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  enroll(@User() user: AuthenticatedUser) {
    return this.factor.enrol(user.id);
  }

  @Firewall({ sensitive: true })
  @RateLimit('auth.mfa.ip')
  @UseGuards(JsonOnlyGuard)
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async confirm(@User() user: AuthenticatedUser, @Body() body: MfaConfirmDto) {
    return { recoveryCodes: await this.factor.confirm(user.id, body.code) };
  }

  @RateLimit('auth.mfa.ip')
  @UseGuards(JsonOnlyGuard)
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @Header('Pragma', 'no-cache')
  async verify(
    @Body() body: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const delivery = body.delivery ?? 'body';
    // Before the challenge is touched: a refused origin must leave it intact.
    if (delivery === 'cookie') assertOriginAllowed(req, this.config);
    const token =
      body.mfaToken ??
      (delivery === 'cookie'
        ? cookie.parse(req.headers.cookie ?? '')[MFA_CHALLENGE_COOKIE]
        : undefined);

    try {
      const issued = await this.login.verify({
        mfaToken: token,
        code: body.code,
        delivery,
        meta: sessionMeta(req),
      });
      if (delivery === 'cookie') {
        this.cookies.clearChallenge(res);
        return this.cookies.set(res, issued);
      }
      const { delivery: _delivery, ...credentials } = issued;
      return credentials;
    } catch (error) {
      // A challenge that is gone, spent or burned is gone for the browser too.
      if (
        delivery === 'cookie' &&
        error instanceof Domain_InvalidMfaChallengeError
      )
        this.cookies.clearChallenge(res);
      throw error;
    }
  }
}
