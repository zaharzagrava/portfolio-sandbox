import { Controller, Get, Res } from '@nestjs/common';
// Header/HttpCode no longer needed: every probe sets its own status and Cache-Control.
import type { Response } from 'express';
import { LivenessService } from './liveness.service';
import { ReadinessService } from './readiness.service';
import { StartupService } from './startup.service';

/**
 * - /health/live: "is this process able to make progress?" Never touches the DB or
 *   Redis - if Postgres is down, restarting every API instance only adds a
 *   reconnect storm on top of the outage.
 * - /health/ready: "should the load balancer send me traffic?" Pod-local checks +
 *   shutdown flag; shared dependencies are reported but do not fail it. Used by ALB target-group health checks (O-03).
 * - /health/startup: "has warm-up finished?"
 * Probes are exempt from throttling and shedding by their path (see exempt-paths), and are never cached.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly startup: StartupService,
    private readonly liveness: LivenessService,
  ) {}

  @Get('health/live')
  live(@Res() res: Response) {
    const { alive, failing } = this.liveness.report();
    res
      .setHeader('Cache-Control', 'no-store')
      .status(alive ? 200 : 503)
      .json({
        status: alive ? 'ok' : 'failing',
        ...(alive ? {} : { failing }),
      });
  }

  @Get('health/startup')
  started(@Res() res: Response) {
    const ok = this.startup.isStarted();
    res
      .setHeader('Cache-Control', 'no-store')
      .status(ok ? 200 : 503)
      .json({ status: ok ? 'started' : 'starting' });
  }

  @Get('health/ready')
  async ready(@Res() res: Response) {
    const report = await this.readiness.report();
    res
      .setHeader('Cache-Control', 'no-store')
      .status(report.ready ? 200 : 503)
      .json(report);
  }
}
