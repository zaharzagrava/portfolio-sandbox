import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { ReadinessService } from './readiness.service';

/**
 * - /livez: "is this process able to make progress?" Never touches the DB or
 *   Redis - if Postgres is down, restarting every API instance only adds a
 *   reconnect storm on top of the outage.
 * - /readyz: "should the load balancer send me traffic?" Critical deps +
 *   shutdown flag. Used by ALB target-group health checks (O-03).
 */
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('livez')
  @HttpCode(200)
  live() {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
  }

  @Get('readyz')
  async ready(@Res() res: Response) {
    const report = await this.readiness.report();
    res.status(report.ready ? 200 : 503).json(report);
  }
}
