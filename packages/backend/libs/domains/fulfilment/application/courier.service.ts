import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import {
  APPLY_LOCATION,
  courierKey,
  geoKey,
  SET_STATUS,
  trackThrottleKey,
} from '../infra/courier-keys';
import { CourierLocationsReported } from './events/courier-events';

export interface LocationPoint {
  lat: number;
  lng: number;
  ts: number;
  accuracy?: number;
}

const MAX_AGE_MS = 5 * 60_000;
const MAX_SKEW_MS = 10_000;
const TRACK_PUSH_EVERY_MS = 2_000;

/**
 * Courier side. The location path is the hot one (50k req/s): one Lua call
 * (latest point only) + one Kafka produce per batch - no Postgres.
 */
@Injectable()
export class CourierService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly producer: KafkaProducerService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async register(
    userId: string,
    city: string,
    vehicle: 'bike' | 'scooter' | 'car',
  ) {
    await this.sequelize.query(
      `INSERT INTO "Courier" (id, city, vehicle) VALUES (:userId, :city, :vehicle) ON CONFLICT (id) DO UPDATE SET city = EXCLUDED.city, vehicle = EXCLUDED.vehicle`,
      { replacements: { userId, city, vehicle } },
    );
    return this.get(userId);
  }

  async get(
    courierId: string,
  ): Promise<{ id: string; city: string; vehicle: string; status: string }> {
    const [courier] = await this.sequelize.query<{
      id: string;
      city: string;
      vehicle: string;
      status: string;
    }>(
      `SELECT id, city, vehicle, status FROM "Courier" WHERE id = :courierId`,
      {
        type: QueryTypes.SELECT,
        replacements: { courierId },
      },
    );
    if (!courier) throw new NotFoundException('Not a courier');
    return courier;
  }

  /** Shift start/end. BUSY is set by dispatch only. */
  async setAvailability(courierId: string, available: boolean) {
    const courier = await this.get(courierId);
    if (courier.status === 'BUSY')
      throw new BadRequestException('Finish the current delivery first');
    const status = available ? 'AVAILABLE' : 'OFFLINE';
    await this.setStatus(courier.city, courierId, status, null);
    return { status };
  }

  async setStatus(
    city: string,
    courierId: string,
    status: 'OFFLINE' | 'AVAILABLE' | 'BUSY',
    deliveryId: string | null,
  ) {
    await this.sequelize.query(
      `UPDATE "Courier" SET status = :status WHERE id = :courierId`,
      { replacements: { status, courierId } },
    );
    await this.redis.client.eval(
      SET_STATUS,
      2,
      courierKey(city, courierId),
      geoKey(city),
      courierId,
      status,
      deliveryId ?? '',
    );
  }

  async report(
    courierId: string,
    city: string,
    points: LocationPoint[],
    now = Date.now(),
  ) {
    const valid = points
      .filter(
        (p) =>
          p.ts >= now - MAX_AGE_MS &&
          p.ts <= now + MAX_SKEW_MS &&
          Math.abs(p.lat) <= 90 &&
          Math.abs(p.lng) <= 180,
      )
      .sort((a, b) => a.ts - b.ts);
    if (valid.length === 0) return { accepted: 0 };
    const latest = valid[valid.length - 1];

    const result = (await this.redis.client.eval(
      APPLY_LOCATION,
      2,
      courierKey(city, courierId),
      geoKey(city),
      courierId,
      latest.ts,
      latest.lat,
      latest.lng,
      300,
    )) as string | null;
    const deliveryId = result || null;

    // Live tracking for the buyer, throttled to one push per 2 s per delivery.
    if (
      deliveryId &&
      (await this.redis.client.set(
        trackThrottleKey(deliveryId),
        '1',
        'PX',
        TRACK_PUSH_EVERY_MS,
        'NX',
      ))
    ) {
      await this.realtime.publish(
        `delivery:${deliveryId}`,
        'courier_position',
        { lat: latest.lat, lng: latest.lng, ts: latest.ts },
        { replay: false },
      );
    }
    await this.producer.send({
      topic: CourierLocationsReported.topic,
      key: city,
      value: CourierLocationsReported.create(courierId, 0, {
        courierId,
        city,
        deliveryId,
        points: valid,
      }),
    });
    return { accepted: valid.length, applied: result !== null };
  }

  async position(
    city: string,
    courierId: string,
  ): Promise<{ lat: number; lng: number; ts: number } | null> {
    const [lat, lng, ts] = await this.redis.client.hmget(
      courierKey(city, courierId),
      'lat',
      'lng',
      'ts',
    );
    return lat && lng && ts
      ? { lat: Number(lat), lng: Number(lng), ts: Number(ts) }
      : null;
  }
}
