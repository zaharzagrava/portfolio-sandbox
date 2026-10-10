import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IsOptional, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { RateLimit, RateLimitExempt } from '../rate-limit.decorator';

export const REQUIRE_AUTH = 'probe:require-auth';
export const REQUIRE_SHOP = 'probe:require-shop';

/**
 * Stand-in for the platform's identity guards (they run before the interceptors): sets `req.user` / `req.apiKey`
 * from headers, refuses with 401 / 403 before any budget is touched.
 */
@Injectable()
export class ProbeAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: { id: string };
        apiKey?: { id: string; shopId?: string };
        shopId?: string;
      }
    >();
    const user = req.headers['x-user'];
    if (typeof user === 'string') req.user = { id: user };
    const key = req.headers['x-api-key'];
    if (typeof key === 'string')
      req.apiKey = {
        id: key,
        shopId: (req.headers['x-key-shop'] as string | undefined) ?? undefined,
      };
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride(REQUIRE_AUTH, targets) && !req.user)
      throw new UnauthorizedException();
    if (this.reflector.getAllAndOverride(REQUIRE_SHOP, targets)) {
      const shopId = String(req.params.shopId);
      const member = String(req.headers['x-shops'] ?? '').split(',');
      if (!member.includes(shopId)) throw new ForbiddenException();
      req.shopId = shopId;
    }
    return true;
  }
}

export class NameDto {
  @IsString() name!: string;
}

export class LoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() outcome?: string;
}

/** Everything the probe handlers did, so specs can prove a throttled request ran nothing. */
export const probeLog = {
  handled: [] as string[],
  oneTimeTokens: 0,
  inFlight: 0,
  release: undefined as (() => void) | undefined,
  reset() {
    this.handled = [];
    this.oneTimeTokens = 0;
    this.inFlight = 0;
    this.release = undefined;
  },
};

@Controller('probe')
@UseGuards(ProbeAuthGuard)
export class ProbeController {
  @Get('token')
  @RateLimit('http.p5')
  token() {
    probeLog.handled.push('token');
    return { ok: true };
  }

  @Get('two')
  @RateLimit('http.a20', 'http.b5')
  two() {
    return { ok: true };
  }

  @Get('refund-bucket')
  @RateLimit('http.a5', 'http.b2')
  refundBucket() {
    return { ok: true };
  }

  @Get('refund-window')
  @RateLimit('http.a5-window', 'http.b2')
  refundWindow() {
    return { ok: true };
  }

  @Get('refund-conc')
  @RateLimit('http.a5-conc', 'http.b2')
  refundConc() {
    return { ok: true };
  }

  @Get('costly')
  @RateLimit({
    policy: 'http.cost',
    cost: (req) => Number(req.query.cost),
  })
  costly(@Query('cost') cost: string) {
    return { cost };
  }

  @Post('validated')
  @RateLimit('http.p5')
  validated(@Body() body: NameDto) {
    return body;
  }

  @Get('secure')
  @SetMetadata(REQUIRE_AUTH, true)
  @RateLimit('http.user', 'http.ip20')
  secure() {
    return { ok: true };
  }

  @Get('shop/:shopId')
  @SetMetadata(REQUIRE_SHOP, true)
  @RateLimit('http.shop')
  shop(@Param('shopId') shopId: string) {
    return { shopId };
  }

  @Get('user')
  @RateLimit('http.user')
  user() {
    return { ok: true };
  }

  @Get('key')
  @RateLimit('http.key', 'http.shop')
  key() {
    return { ok: true };
  }

  @Get('ip')
  @RateLimit('http.ip20')
  ip() {
    return { ok: true };
  }

  @Get('custom')
  @RateLimit({
    policy: 'http.custom',
    subject: (req) => (req.query.who as string | undefined) || undefined,
  })
  custom() {
    return { ok: true };
  }

  @Get('custom-throws')
  @RateLimit({
    policy: 'http.custom',
    subject: () => {
      throw new Error('extractor broke');
    },
  })
  customThrows() {
    probeLog.handled.push('custom-throws');
    return { ok: true };
  }

  @Get('custom-open-throws')
  @RateLimit({
    policy: 'http.custom-open',
    subject: () => {
      throw new Error('extractor broke');
    },
  })
  customOpenThrows() {
    probeLog.handled.push('custom-open-throws');
    return { ok: true };
  }

  @Get('cost-throws')
  @RateLimit({
    policy: 'http.closed',
    cost: () => {
      throw new Error('resolver broke');
    },
  })
  costThrows() {
    probeLog.handled.push('cost-throws');
    return { ok: true };
  }

  @Get('closed')
  @RateLimit('http.closed')
  closed() {
    probeLog.handled.push('closed');
    return { ok: true };
  }

  @Get('open')
  @RateLimit('http.open')
  open() {
    probeLog.handled.push('open');
    return { ok: true };
  }

  @Get('pausable')
  @RateLimit('http.pausable')
  pausable() {
    return { ok: true };
  }

  /** A handler with a side effect: a one-time token. */
  @Post('once')
  @RateLimit('http.three')
  once() {
    probeLog.oneTimeTokens++;
    return { consumed: probeLog.oneTimeTokens };
  }

  @Get('fail/:status')
  @RateLimit('http.p5')
  fail(@Param('status') status: string) {
    if (status === '500') throw new Error('handler blew up');
    throw new HttpException('handler says no', Number(status));
  }

  @Post('login')
  @RateLimit('http.login')
  login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    probeLog.handled.push('login');
    if (body.outcome === 'park')
      return new Promise((resolve) => {
        probeLog.release = () => resolve({ ok: true });
      });
    switch (body.outcome) {
      case 'error500':
        throw new Error('handler blew up');
      case 'bad-request':
        throw new BadRequestException();
      case 'forbidden':
        throw new ForbiddenException();
      default:
    }
    if (body.password !== 'right') throw new UnauthorizedException();
    res.status(200);
    return { ok: true };
  }

  @Post('login-bucket')
  @RateLimit('http.login-bucket')
  loginBucket(@Body() body: LoginDto) {
    if (body.password !== 'right') throw new UnauthorizedException();
    return { ok: true };
  }

  /** Concurrency: parks until `probeLog.release()`; `?mode=` picks the outcome. */
  @Post('slow')
  @RateLimit('http.slow')
  async slow(@Query('mode') mode: string | undefined) {
    probeLog.inFlight++;
    try {
      if (mode === 'error500') throw new Error('handler blew up');
      if (mode === 'error422') throw new HttpException('nope', 422);
      if (mode === 'park')
        await new Promise<void>((resolve) => (probeLog.release = resolve));
      return { ok: true };
    } finally {
      probeLog.inFlight--;
    }
  }

  @Post('slow-open')
  @RateLimit('http.slow-open')
  async slowOpen(@Query('mode') mode: string | undefined) {
    if (mode === 'park')
      await new Promise<void>((resolve) => (probeLog.release = resolve));
    return { ok: true };
  }

  /** Neither `@RateLimit` nor `@RateLimitExempt`: the default limit applies. */
  @Get('plain')
  plain() {
    return { ok: true };
  }

  @Post('plain-write')
  plainWrite() {
    return { ok: true };
  }

  @Get('exempt')
  @RateLimitExempt('probe route that must never be limited')
  exempt() {
    return { ok: true };
  }

  @Get('echo-ip')
  @RateLimitExempt('reports the resolved address')
  echoIp(@Req() req: Request & { clientIp?: string }) {
    return { ip: req.clientIp };
  }
}
