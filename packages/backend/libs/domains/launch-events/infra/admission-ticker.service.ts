import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import LaunchEvent from './models/launch-event.model';
import {
  ACTIVE_ROOMS_KEY,
  WaitingRoomService,
} from '../application/waiting-room.service';
import { SeatHoldService } from '../application/seat-hold.service';

const TICK_MS = 1_000;
const LEADER_KEY = 'wr:admitter:leader';

/**
 * Admits `admissionRatePerSec` users per active event every second - a token
 * bucket on admission (lesson 06/03 §5). Runs in every worker, but only the
 * instance holding the short-lived Redis leader lease ticks, so the rate is
 * per event, not per worker. Also hosts the hold-expiry job.
 */
@Injectable()
export class AdmissionTicker implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdmissionTicker.name);
  private timer?: NodeJS.Timeout;
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly redis: RedisService,
    private readonly room: WaitingRoomService,
    private readonly holds: SeatHoldService,
    @InjectModel(LaunchEvent) private readonly eventModel: typeof LaunchEvent,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'waiting-room.admitter.stop',
      order: 10,
      run: () => {
        clearInterval(this.timer);
        return Promise.resolve();
      },
    });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) => this.logger.warn(`tick: ${e.message}`)),
      TICK_MS,
    );
    this.timer.unref();
  }

  async tick(): Promise<void> {
    const lead = await this.redis.client.set(
      LEADER_KEY,
      this.instanceId,
      'PX',
      TICK_MS * 2,
      'NX',
    );
    const owner =
      lead === 'OK' ? this.instanceId : await this.redis.client.get(LEADER_KEY);
    if (owner !== this.instanceId) return;
    await this.redis.client.pexpire(LEADER_KEY, TICK_MS * 2);

    for (const eventId of await this.redis.client.smembers(ACTIVE_ROOMS_KEY)) {
      const event = await this.eventModel.findByPk(eventId, {
        attributes: ['id', 'salesOpenAt', 'admissionRatePerSec'],
        raw: true,
      });
      if (!event) {
        await this.redis.client.srem(ACTIVE_ROOMS_KEY, eventId);
        continue;
      }
      if (new Date(event.salesOpenAt).getTime() > Date.now()) continue;
      await this.room.admit(eventId, event.admissionRatePerSec);
      if ((await this.room.queueLength(eventId)) === 0)
        await this.redis.client.srem(ACTIVE_ROOMS_KEY, eventId);
    }
  }

  @JobHandler('launch-events.expire-hold', { concurrency: 100 })
  async expireHold({ holdId }: { holdId: string }) {
    await this.holds.release(holdId);
  }
}
