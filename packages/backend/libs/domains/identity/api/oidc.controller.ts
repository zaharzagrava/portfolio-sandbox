import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
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
import { Domain_InvalidCodeError } from '../domain/errors';
import { OidcCallbackService } from '../application/oidc-callback.service';
import { OidcFlowService } from '../application/oidc-flow.service';
import { OidcProviderRegistry } from '../application/oidc-provider-registry';
import { SecondFactorService } from '../application/second-factor.service';
import { CredentialCookies, OIDC_FLOW_COOKIE } from './credential-cookies';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import { JsonOnlyGuard } from './guards/json-only.guard';
import { OriginGuard } from './guards/origin.guard';
import { sessionMeta } from './request-meta';
import { OidcLinkStartDto, OidcStartDto } from './auth.dto';

const NO_STORE = 'no-store';

/**
 * Sign in with an identity provider. `start` is a POST (it creates state) and returns the URL for the browser to
 * navigate to; the callback is the provider's redirect target and always answers with a redirect: to the page the
 * user asked for, or to `/login?error=<closed code>`.
 */
@ApiTags('auth')
@Controller('auth/oidc')
export class OidcController {
  constructor(
    private readonly registry: OidcProviderRegistry,
    private readonly flows: OidcFlowService,
    private readonly callbacks: OidcCallbackService,
    private readonly factor: SecondFactorService,
    private readonly cookies: CredentialCookies,
    private readonly config: ApiConfigService,
  ) {}

  @Get('providers')
  providers() {
    return this.registry.list();
  }

  @RateLimit('auth.oidc.ip')
  @UseGuards(OriginGuard, JsonOnlyGuard)
  @Post(':provider/start')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  async start(
    @Param('provider') provider: string,
    @Body() body: OidcStartDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { authorizationUrl, flowCookie } = await this.flows.start({
      provider,
      returnTo: body.returnTo,
      purpose: 'login',
    });
    this.cookies.setFlow(res, flowCookie);
    return { authorizationUrl };
  }

  @Firewall({ sensitive: true })
  @RateLimit('auth.oidc.ip', 'auth.mfa.ip')
  @UseGuards(OriginGuard, JsonOnlyGuard)
  @Post(':provider/link/start')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  async linkStart(
    @User() user: AuthenticatedUser,
    @Param('provider') provider: string,
    @Body() body: OidcLinkStartDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Adding a way in is as sensitive as removing the second factor: it needs a current code when one is enabled.
    if (await this.factor.isSecondFactorEnrolled(user.id)) {
      if (!body.code) throw new Domain_InvalidCodeError();
      await this.factor.consumeTotpCode(user.id, body.code);
    }
    const { authorizationUrl, flowCookie } = await this.flows.start({
      provider,
      returnTo: body.returnTo,
      purpose: 'link',
      userId: user.id,
    });
    this.cookies.setFlow(res, flowCookie);
    return { authorizationUrl };
  }

  @RateLimit('auth.oidc.ip')
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.callbacks.handle({
      provider,
      query: req.query as Record<string, unknown>,
      flowCookie: cookie.parse(req.headers.cookie ?? '')[OIDC_FLOW_COOKIE],
      meta: sessionMeta(req),
    });

    const front = new URL(this.config.get('front_host')).origin;
    this.cookies.clearFlow(res);
    res.setHeader('Cache-Control', NO_STORE);
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (result.kind === 'failure')
      return res.redirect(302, `${front}/login?error=${result.code}`);
    if (result.kind === 'linked') {
      const sep = result.returnPath.includes('?') ? '&' : '?';
      return res.redirect(
        302,
        `${front}${result.returnPath}${sep}linked=google`,
      );
    }
    this.cookies.set(res, result.issued);
    return res.redirect(302, `${front}${result.returnPath}`);
  }
}
