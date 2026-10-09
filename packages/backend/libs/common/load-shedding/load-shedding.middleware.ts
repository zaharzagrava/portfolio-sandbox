import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { trace } from '@opentelemetry/api';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { PlatformCodes } from '@app/common/errors/platform-codes';
import { buildProblemDocument } from '@app/common/exceptions-filter/problem-document';
import { isExemptPath } from '@app/common/logging/exempt-paths';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  MetadataRoute,
  matchMetadataRoute,
  scanMetadataRoutes,
} from '@app/common/routing/route-metadata';
import { EventLoopMonitor } from './event-loop-monitor.service';
import { LOAD_SHEDDING_PRIORITY } from './priority.decorator';
import { Priority, SheddingPolicy } from './shedding-policy';

export const LOAD_SHEDDING_OPTIONS = Symbol('LOAD_SHEDDING_OPTIONS');
export interface LoadSheddingOptions {
  /** Lag threshold `T` in ms: background is shed at `T`, default at `2T`, critical at `5T`. */
  thresholdMs: number;
  /** Concurrent requests per instance; default and background are shed at the cap, critical at twice the cap. */
  inflightCap: number;
}

const DEFAULT_OPTIONS: LoadSheddingOptions = {
  thresholdMs: 200,
  inflightCap: 1_000,
};
const LOG_INTERVAL_MS = 1_000;
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

const RETRY_AFTER_SECONDS = () => 1 + Math.floor(Math.random() * 3);

/**
 * Rejects new work early with `503 service_overloaded` when the event loop or the in-flight count says the instance
 * cannot take more (FR-048 to FR-054). It is mounted by the bootstrap with `app.use` BEFORE the body parsers, so a shed
 * request costs one header write: no body read, no authentication, no rate-limit budget, no access log. Probes and the
 * metrics endpoint are never shed.
 */
@Injectable()
export class LoadSheddingGate {
  private readonly logger = new Logger(LoadSheddingGate.name);
  private readonly policy: SheddingPolicy;
  private readonly shedCounter = MetricsRegistry.counter({
    name: 'http_requests_shed_total',
    help: 'Requests refused by load shedding',
    labels: ['priority'],
  });
  private inflightCount = 0;
  private routes?: MetadataRoute<Priority>[];
  private shedSinceLog = 0;
  private lastLogAt?: number;

  constructor(
    monitor: EventLoopMonitor,
    private readonly discovery: DiscoveryService,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ApiConfigService,
    @Optional()
    @Inject(LOAD_SHEDDING_OPTIONS)
    options?: Partial<LoadSheddingOptions>,
  ) {
    this.policy = new SheddingPolicy({
      thresholdMs:
        options?.thresholdMs ??
        config.get('load_shedding_lag_ms') ??
        DEFAULT_OPTIONS.thresholdMs,
      inflightCap:
        options?.inflightCap ??
        config.get('load_shedding_max_inflight') ??
        DEFAULT_OPTIONS.inflightCap,
    });
    // If the monitor never starts no window arrives, the policy stays at "admit" and only the in-flight cap applies (fail open).
    monitor.onWindow((p99Ms) => this.policy.observe(p99Ms));
  }

  inflight(): number {
    return this.inflightCount;
  }

  /** Express handler; `globalPrefix` is the app's route prefix (routes are declared without it). */
  middleware(options: { globalPrefix?: string | false } = {}): RequestHandler {
    const prefix = options.globalPrefix
      ? `/${options.globalPrefix.replace(/^\/|\/$/g, '')}`
      : '';
    return (req: Request, res: Response, next: NextFunction) => {
      if (isExemptPath(req.path)) return next();
      const priority = this.priorityOf(req, prefix);
      const decision = this.policy.decide(priority, this.inflightCount);
      if (decision === 'admit') return this.admit(res, next);
      this.shed(req, res, priority);
    };
  }

  private admit(res: Response, next: NextFunction): void {
    this.inflightCount++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inflightCount--;
    };
    // `close` also fires when the client aborts before a response, so a dropped request never leaks a slot.
    res.once('finish', release);
    res.once('close', release);
    next();
  }

  private shed(req: Request, res: Response, priority: Priority): void {
    this.shedCounter.add(1, { priority });
    this.logSampled();

    const header = req.headers['x-request-id'];
    const requestId =
      typeof header === 'string' && VALID_REQUEST_ID.test(header)
        ? header
        : uuidv7();
    const error = new AppError({
      code: PlatformCodes.service_overloaded,
      status: HttpStatus.SERVICE_UNAVAILABLE,
      title: 'Service Unavailable',
      detail: 'The server is temporarily overloaded. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: RETRY_AFTER_SECONDS(),
    });
    const problem = buildProblemDocument(error, {
      requestId,
      instance: req.path,
      traceId: trace.getActiveSpan()?.spanContext().traceId,
    });
    for (const [name, value] of Object.entries(problem.headers))
      res.setHeader(name, value);
    res.setHeader('x-request-id', requestId);
    res.setHeader('Connection', 'close');
    res
      .status(problem.status)
      .type('application/problem+json')
      .send(JSON.stringify(problem.body));
  }

  /** At most one `warn` per second, carrying how many requests were shed since the last line; the metric counts every one. */
  private logSampled(): void {
    this.shedSinceLog++;
    const now = this.clock.nowMs();
    if (this.lastLogAt !== undefined && now - this.lastLogAt < LOG_INTERVAL_MS)
      return;
    this.lastLogAt = now;
    this.logger.warn({
      message: 'load shedding active',
      shedCount: this.shedSinceLog,
    });
    this.shedSinceLog = 0;
  }

  private priorityOf(req: Request, prefix: string): Priority {
    // Only routes that declare a non-default priority are kept; everything else is `default`.
    this.routes ??= scanMetadataRoutes<Priority>(
      this.discovery,
      LOAD_SHEDDING_PRIORITY,
    ).filter((r) => r.value !== 'default');
    return (
      matchMetadataRoute(this.routes, req.method, req.path, prefix) ?? 'default'
    );
  }
}
