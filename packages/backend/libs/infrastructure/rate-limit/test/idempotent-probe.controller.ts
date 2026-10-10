import { Controller, Post, UseGuards } from '@nestjs/common';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '../rate-limit.decorator';
import { ProbeAuthGuard } from './probe.controller';

export const idempotentCalls = { created: 0 };

/**
 * A route that honours `Idempotency-Key` and is limited to 3 requests (AS-47). The second route lists the decorators in
 * the opposite order: throttling must run first either way, because it is a global interceptor.
 */
@Controller('probe-idem')
@UseGuards(ProbeAuthGuard)
export class IdempotentProbeController {
  @Post('create')
  @RateLimit('http.three')
  @Idempotent()
  create() {
    return { n: ++idempotentCalls.created };
  }

  @Post('create-reversed')
  @Idempotent()
  @RateLimit('http.three')
  createReversed() {
    return { n: ++idempotentCalls.created };
  }
}
