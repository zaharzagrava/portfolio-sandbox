import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ClockView } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';

export const CLOCK_OFFSET_KEY = 'clock:offsetSeconds';
/** How long a process may keep using an offset it has read (S54.R-21: new time everywhere within 1 s). */
export const CLOCK_CACHE_MS = 200;

/**
 * The platform clock (`CLOCK`). Real time, plus a forward offset shared through Redis while `CLOCK_CONTROL=enabled`;
 * with the control off it is the system clock and touches no store. `now()` is synchronous: the offset is refreshed in
 * the background every `CLOCK_CACHE_MS`, and a local change applies at once.
 */
@Injectable()
export class ClockService
  extends Clock
  implements OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(ClockService.name);
  private offsetSeconds = 0;
  private redis?: RedisService;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly config?: ApiConfigService,
  ) {
    super();
  }

  get enabled(): boolean {
    try {
      return this.config?.get('clock_control') === 'enabled';
    } catch {
      return false;
    }
  }

  now(): Date {
    return new Date(Date.now() + this.offsetSeconds * 1000);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    this.redis = this.moduleRef.get(RedisService, { strict: false });
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), CLOCK_CACHE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  view(): ClockView {
    return {
      now: this.now().toISOString(),
      mode: this.offsetSeconds > 0 ? 'offset' : 'real',
      offsetSeconds: this.offsetSeconds,
    };
  }

  /** Adds `seconds` to the shared offset (atomic across processes). */
  async advance(seconds: number): Promise<ClockView> {
    this.offsetSeconds = await this.client().incrby(CLOCK_OFFSET_KEY, seconds);
    return this.view();
  }

  /** Back to the real time everywhere (idempotent). */
  async reset(): Promise<ClockView> {
    await this.client().del(CLOCK_OFFSET_KEY);
    this.offsetSeconds = 0;
    return this.view();
  }

  private client() {
    if (!this.redis) throw new Error('clock control is not enabled');
    return this.redis.client;
  }

  private async refresh(): Promise<void> {
    try {
      const raw = await this.client().get(CLOCK_OFFSET_KEY);
      const value = raw === null ? 0 : Number.parseInt(raw, 10);
      this.offsetSeconds = Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
      // keep the last known offset; a Redis blip must not move time backwards
      this.log.warn(`clock offset refresh failed: ${(error as Error).message}`);
    }
  }
}
