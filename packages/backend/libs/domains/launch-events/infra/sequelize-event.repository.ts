import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { EventStatus } from '../domain/event-state';
import type {
  ClosedReason,
  EventRepository,
  LaunchEventRecord,
  NewLaunchEvent,
} from '../domain/ports';
import LaunchEvent from './models/launch-event.model';
import LaunchEventHistory from './models/launch-event-history.model';

const toRecord = (row: LaunchEvent): LaunchEventRecord => ({
  id: row.id,
  shopId: row.shopId,
  title: row.title,
  venue: row.venue,
  startsAt: new Date(row.startsAt),
  salesOpenAt: new Date(row.salesOpenAt),
  seatCount: row.seatCount,
  seatsPerRow: row.seatsPerRow,
  seatingMode: row.seatingMode,
  perUserLimit: row.perUserLimit,
  admissionRatePerSec: row.admissionRatePerSec,
  humanCheckRequired: row.humanCheckRequired,
  status: row.status,
  closedReason: row.closedReason ?? null,
});

@Injectable()
export class SequelizeEventRepository implements EventRepository {
  constructor(
    @InjectModel(LaunchEvent) private readonly events: typeof LaunchEvent,
    @InjectModel(LaunchEventHistory)
    private readonly history: typeof LaunchEventHistory,
    private readonly tx: TransactionRunner,
  ) {}

  async create(input: NewLaunchEvent): Promise<LaunchEventRecord> {
    const row = await this.events.create({ ...input, status: 'SCHEDULED' });
    return toRecord(row);
  }

  async findById(id: string): Promise<LaunchEventRecord | null> {
    const row = await this.events.findByPk(id);
    return row ? toRecord(row) : null;
  }

  async lockById(id: string): Promise<LaunchEventRecord | null> {
    const row = await this.events.findByPk(id, { lock: true });
    return row ? toRecord(row) : null;
  }

  transition(
    id: string,
    from: EventStatus,
    to: EventStatus,
    options: { reason?: string; closedReason?: ClosedReason } = {},
  ): Promise<boolean> {
    return this.tx.run(async () => {
      const [affected] = await this.events.update(
        {
          status: to,
          ...(options.closedReason && { closedReason: options.closedReason }),
        },
        { where: { id, status: from } },
      );
      if (affected !== 1) return false;
      await this.history.create({
        launchEventId: id,
        fromStatus: from,
        toStatus: to,
        reason: options.reason ?? null,
      });
      return true;
    });
  }

  async listReconcilable(closedSince: Date): Promise<LaunchEventRecord[]> {
    const rows = await this.events.findAll({
      where: {
        [Op.or]: [
          { status: { [Op.in]: ['ON_SALE', 'SOLD_OUT'] } },
          { status: 'CLOSED', updatedAt: { [Op.gte]: closedSince } },
        ],
      },
    });
    return rows.map(toRecord);
  }
}
