import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { QueueStatusDto } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { AppError } from '@app/common/errors';
import { HEARTBEAT_SEC } from '../domain/constants';
import {
  LaunchEventError,
  eventClosed,
  eventSoldOut,
  humanCheckFailed,
  ticketNotFound,
  waitingRoomFull,
  waitingRoomUnavailable,
} from '../domain/errors';
import {
  HUMAN_VERIFIER,
  LAUNCH_EVENTS_CONFIG,
  LAUNCH_RANDOM,
  QUEUE_STORE,
  type GateRecord,
  type HumanVerifier,
  type LaunchEventsSettings,
  type QueueStore,
  type TicketView,
} from '../domain/ports';
import { joinScore } from '../domain/queue-score';
import { launchMetrics } from '../launch-metrics';
import { EventGateService } from './event-gate.service';
import { LaunchLimits } from './launch-limits';

const MAX_HUMAN_RESULT = 4_096;

export const toQueueStatus = (
  view: TicketView,
  gate: Pick<GateRecord, 'admissionRatePerSec'>,
): QueueStatusDto => {
  if (view.admitted)
    return {
      ticket: view.ticket,
      admitted: true,
      heartbeatSeconds: HEARTBEAT_SEC,
      expiresAt: new Date(view.expiresAtMs).toISOString(),
      admissionToken: view.admissionToken,
      tokenExpiresAt: new Date(view.tokenExpiresAtMs!).toISOString(),
      ...(view.admittedAtMs !== undefined && {
        admittedAt: new Date(view.admittedAtMs).toISOString(),
      }),
    };
  const position = view.position ?? view.queueLength;
  return {
    ticket: view.ticket,
    admitted: false,
    position,
    queueLength: view.queueLength,
    etaSeconds: Math.ceil(position / gate.admissionRatePerSec),
    heartbeatSeconds: HEARTBEAT_SEC,
    expiresAt: new Date(view.expiresAtMs).toISOString(),
  };
};

/**
 * The virtual waiting room (P0323, P0619, P0326). A join touches only the queue store: the event facts come from the
 * Redis gate (the row is read once per gate miss), the order is the pure scoring rule, creation is one atomic script.
 * When that store is down or the room is full the answer is a `503` and nothing else is touched.
 */
@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);

  constructor(
    @Inject(QUEUE_STORE) private readonly queue: QueueStore,
    @Inject(HUMAN_VERIFIER) private readonly human: HumanVerifier,
    @Inject(LAUNCH_EVENTS_CONFIG)
    private readonly settings: LaunchEventsSettings,
    @Inject(LAUNCH_RANDOM) private readonly random: () => number,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gates: EventGateService,
    private readonly limits: LaunchLimits,
  ) {}

  async join(
    eventId: string,
    userId: string,
    humanResult: string | undefined,
  ): Promise<{ status: QueueStatusDto; created: boolean }> {
    try {
      const gate = await this.gates.require(eventId, { strict: true });
      if (gate.status === 'CLOSED') throw this.refused('closed', eventClosed());
      if (gate.status === 'SOLD_OUT')
        throw this.refused('closed', eventSoldOut());
      if (gate.humanCheckRequired) await this.checkHuman(humanResult);

      const nowMs = this.clock.nowMs();
      const result = await this.queue.join({
        eventId,
        userId,
        newTicket: randomUUID(),
        score: joinScore({
          nowMs,
          salesOpenAtMs: gate.salesOpenAtMs,
          random: this.random,
        }),
        nowMs,
        maxLength: this.settings.queueMaxLength,
      });
      if (result.kind === 'full') throw this.refused('full', waitingRoomFull());
      if (result.kind === 'created') {
        // The limit counts new tickets, so the idempotent repeats of one buyer never use it up (AS-02 vs AS-12). A refusal
        // takes the ticket that was just made back, leaving the room as it was.
        try {
          await this.limits.take('launch.queue.join.user', `user:${userId}`);
        } catch (error) {
          await this.queue.retract(eventId, result.ticket, userId);
          throw error;
        }
      }
      const view = await this.queue.view(eventId, result.ticket, userId, nowMs);
      if (!view) throw ticketNotFound();
      launchMetrics.joins.add(1, { result: result.kind });
      return {
        status: toQueueStatus(view, gate),
        created: result.kind === 'created',
      };
    } catch (error) {
      if (error instanceof AppError) throw error; // a domain answer or the limiter's 429
      launchMetrics.joins.add(1, { result: 'unavailable' });
      this.logger.warn(`waiting room store failed: ${(error as Error)?.name}`);
      throw waitingRoomUnavailable();
    }
  }

  /** Owner-only status; refreshes the heartbeat. Every other case is the same `404`. */
  async status(
    eventId: string,
    ticket: string,
    userId: string,
  ): Promise<QueueStatusDto> {
    try {
      const view = await this.queue.view(
        eventId,
        ticket,
        userId,
        this.clock.nowMs(),
      );
      if (!view) throw ticketNotFound();
      const gate = await this.gates.require(eventId, { strict: true });
      return toQueueStatus(view, gate);
    } catch (error) {
      if (error instanceof LaunchEventError) throw error;
      this.logger.warn(`waiting room store failed: ${(error as Error)?.name}`);
      throw waitingRoomUnavailable();
    }
  }

  /** Owner of a ticket by its ID alone, for the realtime topic policy; `null` for an unknown ticket or a store fault. */
  async ownerOf(ticket: string): Promise<string | null> {
    try {
      return await this.queue.ownerOf(ticket);
    } catch {
      return null;
    }
  }

  private async checkHuman(result: string | undefined): Promise<void> {
    if (
      !result ||
      result.length > MAX_HUMAN_RESULT ||
      !/^[\x21-\x7e]+$/.test(result)
    ) {
      launchMetrics.joins.add(1, { result: 'human_check_failed' });
      throw humanCheckFailed();
    }
    let valid: boolean;
    try {
      valid = await this.human.verify(result); // at most one attempt per request, fails closed
    } catch {
      launchMetrics.joins.add(1, { result: 'unavailable' });
      throw waitingRoomUnavailable();
    }
    const fingerprint = createHash('sha256').update(result).digest('hex');
    if (!valid || !(await this.queue.claimHumanResult(fingerprint))) {
      launchMetrics.joins.add(1, { result: 'human_check_failed' });
      throw humanCheckFailed();
    }
  }

  private refused(result: 'full' | 'closed', error: LaunchEventError) {
    launchMetrics.joins.add(1, { result });
    return error;
  }
}
