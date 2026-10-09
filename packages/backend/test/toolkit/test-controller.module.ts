import {
  Body,
  CallHandler,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpException,
  Injectable,
  Module,
  NestInterceptor,
  Param,
  PipeTransform,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { SensitivePathParams } from '@app/common/exceptions-filter/sensitive-path-params.decorator';
import { IsInt, IsString, MinLength } from 'class-validator';
import type { Response } from 'express';
import {
  BadRequestError,
  Fatal_InternalServerError,
} from '@app/common/errors/error.types';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { SecurityPolicy } from '@app/infrastructure/platform/security-policy.decorator';

/** Stages the pipeline probe route passes through, in order (S54 AS-140). */
export const pipelineStages: string[] = [];
const stage = (name: string) => void pipelineStages.push(name);

@Injectable()
class ProbeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    stage('guards');
    if (!context.switchToHttp().getRequest().headers['x-user'])
      throw new HttpException('no credentials', 401);
    return true;
  }
}

@Injectable()
class ProbeMetricsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    stage('metrics');
    return next.handle();
  }
}

@Injectable()
class ProbeRateLimitInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    stage('rate-limit');
    if (context.switchToHttp().getRequest().headers['x-throttle'])
      throw new HttpException('slow down', 429);
    return next.handle();
  }
}

@Injectable()
class ProbeIdempotencyInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    stage('idempotency');
    return next.handle();
  }
}

class RecordingPipe implements PipeTransform {
  transform(value: unknown) {
    stage('pipe');
    return value;
  }
}

export class ValidatedDto {
  @IsString() @MinLength(3) name!: string;
  @IsInt() count!: number;
}

/** Routes the toolkit e2e specs drive: each throws one kind of error, holds a delay, or reads the context. */
@Controller('t')
export class ToolkitTestController {
  readonly calls = { count: 0 };

  constructor(private readonly ctx: RequestContext) {}

  @Get('embed') @SecurityPolicy('public-embed') embed() {
    return { embed: true };
  }

  @Get('big') big() {
    return { data: 'x'.repeat(5 * 1024) };
  }

  @Get('small') small() {
    return { data: 'x'.repeat(100) };
  }

  @Get('sse') sse(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${'x'.repeat(5 * 1024)}\n\n`);
    res.end();
  }

  @Get('no-transform') noTransform(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-transform');
    return { data: 'x'.repeat(5 * 1024) };
  }

  @Post('raw') raw(@Req() req: { rawBody?: Buffer }) {
    return {
      hmac: createHmac('sha256', 'webhook-secret')
        .update(req.rawBody ?? Buffer.alloc(0))
        .digest('hex'),
      length: req.rawBody?.length ?? 0,
    };
  }

  @Get('ip') ip(@Req() req: { clientIp?: string }) {
    return { req: req.clientIp, ctx: this.ctx.snapshot().clientIp };
  }

  @Post('pipeline')
  @UseGuards(ProbeAuthGuard)
  @UseInterceptors(
    ProbeMetricsInterceptor,
    ProbeRateLimitInterceptor,
    ProbeIdempotencyInterceptor,
  )
  pipeline(@Body(new RecordingPipe()) body: ValidatedDto) {
    stage('handler');
    return body;
  }

  @Get('ok') ok() {
    this.calls.count++;
    return { ok: true };
  }

  @Get('type-error') typeError(): never {
    return (undefined as unknown as { x: { y: number } }).x.y as never;
  }

  @Get('app-error') appError(): never {
    throw new BadRequestError('bad thing happened');
  }

  @Get('internal-with-secret') internalWithSecret(): never {
    throw new Fatal_InternalServerError({
      detail: 'relation "User" does not exist at db.internal.local',
    });
  }

  @Get('http-error/:status') httpError(@Param('status') status: string): never {
    throw new HttpException('http failure', Number(status));
  }

  @Get('unauthorized') unauthorized(): never {
    throw Object.assign(new HttpException('no credentials', 401), {
      headers: { 'WWW-Authenticate': 'Bearer realm="api"' },
    });
  }

  @Get('unique-violation') uniqueViolation(): never {
    throw Object.assign(
      new Error(
        'duplicate key value violates unique constraint "users_email_key" Key (email)=(a@b.c)',
      ),
      { code: '23505' },
    );
  }

  @Get('secret/:token') @SensitivePathParams('token') secret(): never {
    throw new BadRequestError('bad token');
  }

  @Get('headers-sent') headersSent(@Res() res: Response): void {
    res.status(200).write('partial');
    throw new Error('boom after headers');
  }

  @Get('context') context() {
    return {
      requestId: this.ctx.requestId,
      userId: this.ctx.userId,
      shopId: this.ctx.shopId,
    };
  }

  @Get('delay/:ms') async delay(@Param('ms') ms: string) {
    await new Promise((r) => setTimeout(r, Number(ms)));
    return { requestId: this.ctx.requestId };
  }

  @Post('validate') validate(@Body() body: ValidatedDto) {
    return body;
  }
}

@Module({ controllers: [ToolkitTestController] })
export class ToolkitTestControllerModule {}
