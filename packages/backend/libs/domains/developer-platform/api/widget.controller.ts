import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Options,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { widgetIdentifyRequestSchema } from '@marketplace-sandbox/contracts';

/**
 * The body of `identify`. A missing token is not a validation problem: like any other bad token it is the one
 * `401 identity_token_invalid` (AS-31); a token over 4 KiB is `400 validation_failed`.
 */
const identifyBodySchema = widgetIdentifyRequestSchema.extend({
  token: widgetIdentifyRequestSchema.shape.token.optional(),
});
import { RateLimit } from '@app/infrastructure/rate-limit';
import { SecurityPolicy } from '@app/infrastructure/platform/security-policy.decorator';
import { WidgetIdentityService } from '../application/widget-identity.service';
import { WidgetPublicService } from '../application/widget-public.service';
import { WidgetSessionService } from '../application/widget-session.service';
import { isPublishableKey } from '../domain/site-rules';
import {
  originNotAllowed,
  widgetDisabled,
  widgetTokenInvalid,
  WidgetError,
} from '../domain/widget-errors';
import { allowRegisteredOrigin, answerPreflight } from './widget-cors';
import { JsonOnlyGuard } from './widget-json.guard';
import { ZodBodyPipe } from './zod-body.pipe';

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/;

/** `identity` limiter subject: the key of the body, but only when it is well formed (a made-up key must not open a counter). */
const siteSubject = (req: Request): string | null => {
  const key = (req.body as { key?: unknown } | undefined)?.key;
  return isPublishableKey(key) ? key : null;
};

/**
 * The public widget API (FR-011…FR-026), `/api/widget/v1`. Anonymous (no `Firewall`: the platform's optional
 * authentication would read the marketplace session cookie and its CSRF check, FR-023), never sets a cookie, per-site CORS
 * (`widget-site` policy: the global CORS policy does not apply and `OPTIONS` reaches `preflight`). Order on every route:
 * key → site → origin → switch and shop status → the rest; the registered origin is echoed as soon as it matched, so a
 * `410` still answers the page that asked.
 */
@ApiTags('widget')
@Controller('widget/v1')
@SecurityPolicy('widget-site')
export class WidgetController {
  constructor(
    private readonly pub: WidgetPublicService,
    private readonly identity: WidgetIdentityService,
    private readonly session: WidgetSessionService,
  ) {}

  @RateLimit('widget.config.ip')
  @Get('config')
  async config(
    @Query('key') key: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = await this.pub.resolveSite(key, 'config');
    const origin = this.pub.assertOrigin(site, req.headers.origin, 'config');
    allowRegisteredOrigin(res, origin);
    try {
      this.pub.assertEnabled(site, 'config');
    } catch {
      // A switched-off site must not melt the origin: the refusal may be shared for 30 s (FR-029).
      throw new WidgetError('widget_disabled', 'This widget is switched off.', {
        headers: { 'Cache-Control': 'public, s-maxage=30' },
      });
    }
    const { body, stale } = await this.pub.shapedConfig(site);
    if (stale) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=15');
      res.setHeader('Warning', '110 - "Response is Stale"');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    }
    return body;
  }

  @UseGuards(JsonOnlyGuard)
  @RateLimit('widget.identify.ip', {
    policy: 'widget.identify.site',
    subject: siteSubject,
  })
  @Post('identify')
  @HttpCode(200)
  async identify(
    @Body(new ZodBodyPipe(identifyBodySchema))
    body: { key: string; token?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = await this.pub.resolveSite(body.key, 'identify');
    const origin = this.pub.assertOrigin(site, req.headers.origin, 'identify');
    allowRegisteredOrigin(res, origin);
    this.pub.assertEnabled(site, 'identify');
    return this.identity.identify(site, body.token ?? '');
  }

  @Get('session')
  async sessionOf(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = BEARER.exec(authorization ?? '')?.[1];
    if (!token) throw widgetTokenInvalid();
    const origin =
      typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const result = await this.session.check(token, origin);
    if (!result.ok) {
      if (result.reason === 'origin') throw originNotAllowed();
      if (result.reason === 'disabled') {
        allowRegisteredOrigin(res, origin);
        throw widgetDisabled();
      }
      throw widgetTokenInvalid();
    }
    allowRegisteredOrigin(res, origin);
    const { principal } = result;
    return {
      site: { id: principal.siteId },
      customer: {
        id: principal.externalCustomerId,
        email: principal.email,
      },
      expiresAt: principal.expiresAt,
    };
  }

  /**
   * The iframe document: the only response of the application that may be framed, and only by this site's origins. A
   * navigation carries no `Origin`, so the framing policy is the control; refusals are problem documents that cannot be
   * framed and never echo the submitted key.
   */
  @RateLimit('widget.config.ip')
  @Get('embed')
  async embed(@Query('key') key: unknown, @Res() res: Response) {
    const site = await this.pub.resolveSite(key, 'embed');
    this.pub.assertEnabled(site, 'embed');
    const { html, csp } = this.pub.embed(site);
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.removeHeader('X-Frame-Options'); // a conflicting value would override the allowlist in older browsers
    res.send(html);
  }

  @Options(['config', 'identify', 'session'])
  @HttpCode(204)
  async preflight(
    @Query('key') key: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    // A key that cannot be resolved is refused like an unregistered origin: a preflight leaks nothing about keys (AS-18).
    const site = await this.pub.resolveSite(key, 'config').catch((error) => {
      throw error instanceof WidgetError &&
        error.code === 'widget_site_not_found'
        ? originNotAllowed()
        : error;
    });
    const origin = this.pub.assertOrigin(site, req.headers.origin, 'config');
    answerPreflight(res, origin);
  }
}
