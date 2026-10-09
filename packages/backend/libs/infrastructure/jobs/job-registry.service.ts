import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  JOB_HANDLER_METADATA,
  JobHandlerOptions,
} from './job-handler.decorator';
import { JobContext, JobType } from './job-types';

export interface RegisteredHandler extends Required<JobHandlerOptions> {
  type: JobType;
  run: (payload: unknown, ctx: JobContext) => Promise<void>;
}

@Injectable()
export class JobRegistry implements OnModuleInit {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly handlers = new Map<string, RegisteredHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;

      for (const methodName of this.scanner.getAllMethodNames(
        Object.getPrototypeOf(instance),
      )) {
        const method = instance[methodName] as (
          ...args: unknown[]
        ) => Promise<void>;
        const meta = this.reflector.get<{ type: JobType } & JobHandlerOptions>(
          JOB_HANDLER_METADATA,
          method,
        );
        if (!meta) continue;
        if (this.handlers.has(meta.type)) {
          this.logger.debug(
            `Ignoring duplicate @JobHandler for "${meta.type}" (likely due to monolith imports)`,
          );
          continue;
        }
        this.handlers.set(meta.type, {
          type: meta.type,
          leaseMs: meta.leaseMs ?? 60_000,
          concurrency: meta.concurrency ?? 10,
          run: (payload, ctx) => method.call(instance, payload, ctx),
        });
      }
    }
    this.logger.log(
      `Job handlers: ${[...this.handlers.keys()].join(', ') || '(none)'}`,
    );
  }

  get(type: string): RegisteredHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
