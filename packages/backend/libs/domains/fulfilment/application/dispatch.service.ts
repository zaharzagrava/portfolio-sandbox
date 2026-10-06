import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { CourierService } from './courier.service';
import { declinedKey, demandKey, geoKey, OFFER_TTL_MS, offerLockKey, surgeKey } from '../infra/courier-keys';
import { DeliveryCommand, DeliveryStatus, transition } from '../domain/delivery-state';
import { geohash } from '../domain/geohash';

export const OFFER_TIMEOUT_QUEUE = 'delivery-offer-timeouts';
const SEARCH_RADII_KM = [3, 6, 12];
const CANDIDATES = 20;
const MAX_ATTEMPTS = 8;
const BASE_FEE_CENTS = 499;

export interface DeliveryRow {
  id: string;
  shopId: string;
  buyerId: string;
  city: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  status: DeliveryStatus;
  courierId: string | null;
  offeredCourierId: string | null;
  attempt: number;
  feeCents: number;
  surge: string;
}

export interface OfferTimeout {
  deliveryId: string;
  city: string;
  courierId: string;
  attempt: number;
}

/**
 * Dispatch (10/07 #23): nearest available couriers via GEOSEARCH, offered ONE
 * at a time. A courier can hold one offer at a time - `SET NX PX 15000` on
 * the courier's offer lock is what makes two concurrent dispatches unable to
 * offer the same courier. Offer expiry is an SQS-delayed message (D18), not an
 * in-memory timer, so it survives restarts and runs on any worker.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly queue: TaskQueue,
    private readonly realtime: RealtimePublisher,
    private readonly couriers: CourierService,
  ) {}

  async request(input: { shopId: string; buyerId: string; city: string; pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; orderId?: string }) {
    const cell = geohash(input.pickup.lat, input.pickup.lng, 5);
    const surge = Number((await this.redis.client.hget(surgeKey(input.city), cell)) ?? 1);
    const minute = Math.floor(Date.now() / 60_000);
    await this.redis.client.multi().hincrby(demandKey(input.city, minute), cell, 1).expire(demandKey(input.city, minute), 600).exec();

    const [delivery] = await this.sequelize.query<DeliveryRow>(
      `INSERT INTO "Delivery" ("shopId", "orderId", "buyerId", city, "pickupLat", "pickupLng", "dropoffLat", "dropoffLng", "feeCents", surge)
       VALUES (:shopId, :orderId, :buyerId, :city, :pLat, :pLng, :dLat, :dLng, :fee, :surge) RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          ...input,
          orderId: input.orderId ?? null,
          pLat: input.pickup.lat,
          pLng: input.pickup.lng,
          dLat: input.dropoff.lat,
          dLng: input.dropoff.lng,
          fee: Math.round(BASE_FEE_CENTS * surge),
          surge,
        },
      },
    );
    await this.dispatch(delivery.id);
    return this.get(delivery.id);
  }

  /** Find the nearest courier that is AVAILABLE, hasn't declined this delivery, and isn't holding another offer. */
  async dispatch(deliveryId: string): Promise<string | null> {
    const d = await this.get(deliveryId);
    if (d.status !== 'REQUESTED') return null;
    if (d.attempt >= MAX_ATTEMPTS) {
      await this.apply(deliveryId, { type: 'cancel', reason: 'no courier accepted' });
      await this.realtime.publish(`delivery:${deliveryId}`, 'status', { status: 'CANCELLED', reason: 'no couriers available' });
      return null;
    }
    const declined = new Set(await this.redis.client.smembers(declinedKey(d.city, deliveryId)));

    for (const radiusKm of SEARCH_RADII_KM) {
      const candidates = (await this.redis.client.geosearch(geoKey(d.city), 'FROMLONLAT', d.pickupLng, d.pickupLat, 'BYRADIUS', radiusKm, 'km', 'ASC', 'COUNT', CANDIDATES)) as string[];
      for (const courierId of candidates) {
        if (declined.has(courierId)) continue;
        // The courier-level lock: only one delivery can be offered to a courier at a time.
        if (!(await this.redis.client.set(offerLockKey(d.city, courierId), deliveryId, 'PX', OFFER_TTL_MS, 'NX'))) continue;

        const offered = await this.apply(deliveryId, { type: 'offer', courierId }, (t) =>
          this.sequelize.query(
            `UPDATE "Delivery" SET "offeredCourierId" = :courierId, "offerExpiresAt" = now() + interval '${OFFER_TTL_MS / 1000} seconds', attempt = attempt + 1 WHERE id = :deliveryId`,
            { replacements: { courierId, deliveryId }, transaction: t },
          ),
        );
        if (!offered) {
          await this.releaseLock(d.city, courierId, deliveryId);
          return null; // someone else moved the delivery on (cancelled / offered concurrently)
        }
        const attempt = d.attempt + 1;
        await this.queue.enqueue<OfferTimeout>(OFFER_TIMEOUT_QUEUE, { deliveryId, city: d.city, courierId, attempt }, { delaySeconds: OFFER_TTL_MS / 1000 });
        await this.realtime.publish(`user:${courierId}`, 'delivery_offer', {
          deliveryId,
          pickup: { lat: d.pickupLat, lng: d.pickupLng },
          dropoff: { lat: d.dropoffLat, lng: d.dropoffLng },
          feeCents: d.feeCents,
          expiresInMs: OFFER_TTL_MS,
        });
        return courierId;
      }
    }
    // Nobody free nearby: retry later with the same message type (counts as an attempt).
    await this.sequelize.query(`UPDATE "Delivery" SET attempt = attempt + 1, "updatedAt" = now() WHERE id = :deliveryId AND status = 'REQUESTED'`, { replacements: { deliveryId } });
    await this.queue.enqueue<OfferTimeout>(OFFER_TIMEOUT_QUEUE, { deliveryId, city: d.city, courierId: '', attempt: d.attempt + 1 }, { delaySeconds: 20 });
    return null;
  }

  async accept(deliveryId: string, courierId: string) {
    const d = await this.get(deliveryId);
    const ok = await this.apply(deliveryId, { type: 'accept', courierId }, (t) =>
      this.sequelize.query(
        `UPDATE "Delivery" SET "courierId" = :courierId WHERE id = :deliveryId AND "offeredCourierId" = :courierId AND "offerExpiresAt" > now() RETURNING id`,
        { type: QueryTypes.SELECT, replacements: { courierId, deliveryId }, transaction: t },
      ).then((rows) => {
        if (rows.length === 0) throw new ConflictException('Offer expired or not yours');
      }),
    );
    if (!ok) throw new ConflictException('Offer expired or not yours');
    await this.releaseLock(d.city, courierId, deliveryId);
    await this.couriers.setStatus(d.city, courierId, 'BUSY', deliveryId);
    await this.realtime.publish(`delivery:${deliveryId}`, 'status', { status: 'ASSIGNED', courierId });
    return this.get(deliveryId);
  }

  async decline(deliveryId: string, courierId: string) {
    const d = await this.get(deliveryId);
    if (d.offeredCourierId !== courierId) throw new ConflictException('Not your offer');
    await this.lapse(d, courierId, 'declined');
  }

  /** SQS-delayed offer expiry (or "retry dispatch" when no courier was found: courierId = ''). */
  async onOfferTimeout(msg: OfferTimeout) {
    const d = await this.get(msg.deliveryId).catch(() => null);
    if (!d) return;
    if (!msg.courierId) {
      if (d.status === 'REQUESTED' && d.attempt === msg.attempt) await this.dispatch(d.id);
      return;
    }
    // Stale timer: the offer was accepted/declined, or a newer offer superseded it.
    if (d.status !== 'OFFERED' || d.offeredCourierId !== msg.courierId || d.attempt !== msg.attempt) return;
    await this.lapse(d, msg.courierId, 'timeout');
  }

  async pickUp(deliveryId: string, courierId: string) {
    await this.courierStep(deliveryId, courierId, { type: 'pickUp', courierId });
  }

  async deliver(deliveryId: string, courierId: string) {
    const d = await this.courierStep(deliveryId, courierId, { type: 'deliver', courierId });
    await this.couriers.setStatus(d.city, courierId, 'AVAILABLE', null);
  }

  async get(deliveryId: string): Promise<DeliveryRow> {
    const [d] = await this.sequelize.query<DeliveryRow>(`SELECT * FROM "Delivery" WHERE id = :deliveryId`, { type: QueryTypes.SELECT, replacements: { deliveryId } });
    if (!d) throw new NotFoundException('Delivery not found');
    return d;
  }

  private async courierStep(deliveryId: string, courierId: string, command: DeliveryCommand) {
    const d = await this.get(deliveryId);
    if (d.courierId !== courierId) throw new NotFoundException('Delivery not found');
    if (!(await this.apply(deliveryId, command))) throw new ConflictException(`Cannot ${command.type} from ${d.status}`);
    await this.realtime.publish(`delivery:${deliveryId}`, 'status', { status: transition(command).to });
    return d;
  }

  private async lapse(d: DeliveryRow, courierId: string, why: 'declined' | 'timeout') {
    await this.redis.client.multi().sadd(declinedKey(d.city, d.id), courierId).expire(declinedKey(d.city, d.id), 3600).exec();
    if (await this.apply(d.id, { type: 'offerLapsed' }, (t) => this.sequelize.query(`UPDATE "Delivery" SET "offeredCourierId" = NULL, "offerExpiresAt" = NULL WHERE id = :id`, { replacements: { id: d.id }, transaction: t }), why)) {
      await this.releaseLock(d.city, courierId, d.id);
      await this.dispatch(d.id);
    }
  }

  /**
   * Conditional transition + history row in one transaction. Returns false if
   * the delivery wasn't in an allowed source state (lost a race) - the caller decides.
   */
  private async apply(deliveryId: string, command: DeliveryCommand, extra?: (t: Transaction) => Promise<unknown>, detail?: string): Promise<boolean> {
    const { from, to } = transition(command);
    try {
      return await this.sequelize.transaction(async (t) => {
        const rows = await this.sequelize.query<{ previous: string }>(
          `UPDATE "Delivery" d SET status = :to, version = d.version + 1, "updatedAt" = now()
           FROM (SELECT id, status AS previous FROM "Delivery" WHERE id = :deliveryId FOR UPDATE) p
           WHERE d.id = p.id AND p.previous IN (:from) RETURNING p.previous`,
          { type: QueryTypes.SELECT, replacements: { deliveryId, to, from }, transaction: t },
        );
        if (rows.length === 0) return false;
        await extra?.(t);
        await this.sequelize.query(`INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "courierId", detail) VALUES (:deliveryId, :from, :to, :courierId, :detail)`, {
          replacements: { deliveryId, from: rows[0].previous, to, courierId: 'courierId' in command ? command.courierId : null, detail: detail ?? ('reason' in command ? command.reason : null) },
          transaction: t,
        });
        return true;
      });
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }

  /** Only release the lock if it's still ours (it may have expired and been re-taken by another dispatch). */
  private async releaseLock(city: string, courierId: string, deliveryId: string) {
    await this.redis.client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, offerLockKey(city, courierId), deliveryId);
  }
}
