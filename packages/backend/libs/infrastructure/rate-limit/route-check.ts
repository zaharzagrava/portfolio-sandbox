import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService } from '@nestjs/core';
import { PolicyRegistry } from './policy-registry';
import type { RateLimitRouteOptions } from './rate-limit.decorator';
import {
  RATE_LIMIT_EXEMPT_METADATA,
  RATE_LIMIT_METADATA,
} from './rate-limit.metadata';

/**
 * Startup check of every route that names a policy (FR-051, AS-71): an undeclared policy, or a `custom` key without a
 * subject extractor, fails startup; the exemptions are logged once, with their reasons (FR-049).
 */
@Injectable()
export class RateLimitRouteCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('RateLimit');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: PolicyRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const references: { policy: string; where: string }[] = [];
    const offences: string[] = [];
    const exempt: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype as
        (new (...args: never[]) => unknown) | null;
      if (!metatype?.prototype) continue;
      const classPolicies = Reflect.getMetadata(
        RATE_LIMIT_METADATA,
        metatype,
      ) as RateLimitRouteOptions[] | undefined;
      const classExempt = Reflect.getMetadata(
        RATE_LIMIT_EXEMPT_METADATA,
        metatype,
      ) as string | undefined;
      if (classExempt) exempt.push(`${metatype.name} (${classExempt})`);
      for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
        const handler = (metatype.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
          continue;
        const where = `${metatype.name}.${name}`;
        const policies =
          (Reflect.getMetadata(RATE_LIMIT_METADATA, handler) as
            RateLimitRouteOptions[] | undefined) ?? classPolicies;
        for (const entry of policies ?? []) {
          references.push({ policy: entry.policy, where });
          if (
            this.registry.has(entry.policy) &&
            this.registry.get(entry.policy).key === 'custom' &&
            !entry.subject
          )
            offences.push(
              `${where}: policy "${entry.policy}" is keyed "custom" and needs a subject extractor`,
            );
        }
        const reason = Reflect.getMetadata(
          RATE_LIMIT_EXEMPT_METADATA,
          handler,
        ) as string | undefined;
        if (reason) exempt.push(`${where} (${reason})`);
      }
    }

    try {
      this.registry.assertDeclared(references);
    } catch (error) {
      offences.push((error as Error).message);
    }
    if (offences.length)
      throw new Error(
        `Rate limit configuration error:\n- ${offences.join('\n- ')}`,
      );
    if (exempt.length)
      this.logger.log(
        `routes exempt from the default rate limit (${exempt.length}): ${exempt.join('; ')}`,
      );
  }
}
