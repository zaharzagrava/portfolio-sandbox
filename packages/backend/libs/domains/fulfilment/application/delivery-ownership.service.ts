import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RING_REGISTRY, type RingRegistry } from '../domain/delivery-ports';
import { ownerOf } from '../domain/dispatcher-ring';
import { errorText, logDelivery } from './delivery-log';

/**
 * Which dispatcher instance owns which city (S20 FR-043, R-8, A25). The ring is a pure function of the live instance
 * set (`ownerOf`); this service only reads the set from the registry. Ownership is an optimisation, never a condition
 * of correctness, so every doubt resolves to "process it": a registry that cannot be read, or that lists nobody, makes
 * this instance own every city (`null` below means "no filter").
 */
@Injectable()
export class DeliveryOwnership {
  private readonly logger = new Logger(DeliveryOwnership.name);
  /** Distinct per process: the ring identifies instances, not hosts. */
  readonly instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The live instances; empty when the registry has none or cannot be read. */
  async liveInstances(): Promise<string[]> {
    try {
      return await this.ring.liveInstances(this.clock.nowMs());
    } catch (error) {
      logDelivery(this.logger, 'warn', 'dispatcher.ring_unreadable', {
        error: errorText(error),
      });
      return [];
    }
  }

  /** Whether this instance handles `city` now. */
  async owns(city: string): Promise<boolean> {
    return this.ownsIn(city, await this.liveInstances());
  }

  /**
   * The cities of `cities` that `instanceId` (default: this one) owns; `null` when there is no instance set, which means
   * "every city".
   */
  async ownedCities(
    cities: readonly string[],
    instanceId: string = this.instanceId,
  ): Promise<string[] | null> {
    const instances = await this.liveInstances();
    if (instances.length === 0) return null;
    return cities.filter((city) => ownerOf(city, instances) === instanceId);
  }

  /** The live instances other than this one (empty without a ring). */
  async peers(): Promise<string[]> {
    return (await this.liveInstances()).filter((id) => id !== this.instanceId);
  }

  private ownsIn(city: string, instances: readonly string[]): boolean {
    if (instances.length === 0) return true;
    return ownerOf(city, instances) === this.instanceId;
  }
}
