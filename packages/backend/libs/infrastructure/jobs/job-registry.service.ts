import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { JOB_HANDLER_METADATA } from './job-handler.decorator';
import {
  JobHandlerOptions,
  ResolvedHandlerOptions,
  resolveHandlerOptions,
} from './handler-options';
import { getJobTypeDeclaration } from './job-type-registry';
import { JobContext, JobType } from './job-types';

export interface RegisteredHandler extends ResolvedHandlerOptions {
  /** `Class.method` of the provider, to tell a re-discovered provider from a second one. */
  provider: string;
  run: (payload: unknown, ctx: JobContext) => Promise<void>;
}

/**
 * Discovers every `@JobHandler` at boot. Startup fails, naming the type and the cause, for: a bad type name or option, a
 * type without a `declareJobType()`, and a second provider for the same type. The same provider found again (a module
 * imported twice in a monolith) is ignored.
 */
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

        const provider = `${instance.constructor.name}.${methodName}`;
        const existing = this.handlers.get(meta.type);
        if (existing) {
          if (existing.provider === provider) {
            this.logger.debug(
              `Ignoring re-discovered @JobHandler for "${meta.type}" (${provider})`,
            );
            continue;
          }
          throw new Error(
            `duplicate @JobHandler for "${meta.type}": ${existing.provider} and ${provider}`,
          );
        }

        const declaration = getJobTypeDeclaration(meta.type);
        if (!declaration)
          throw new Error(
            `@JobHandler("${meta.type}") on ${provider} has no declareJobType() for that type`,
          );
        const options = resolveHandlerOptions(meta.type, {
          ...meta,
          leaseMs: meta.leaseMs ?? declaration.leaseMs,
        });
        this.handlers.set(meta.type, {
          ...options,
          provider,
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
