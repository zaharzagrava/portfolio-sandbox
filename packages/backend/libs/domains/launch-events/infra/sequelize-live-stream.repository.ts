import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { LiveStatus } from '../domain/live-state';
import type {
  LiveStreamRecord,
  LiveStreamRepository,
  PinChange,
} from '../domain/live-ports';
import LiveStream from './models/live-stream.model';

const toRecord = (row: LiveStream): LiveStreamRecord => ({
  id: row.id,
  shopId: row.shopId,
  title: row.title,
  status: row.status,
  launchEventId: row.launchEventId ?? null,
  startedAt: row.startedAt ? new Date(row.startedAt) : null,
  endedAt: row.endedAt ? new Date(row.endedAt) : null,
  createdAt: new Date(row.createdAt),
  pin: row.pin ?? null,
  pinVersion: row.pinVersion ?? 0,
});

@Injectable()
export class SequelizeLiveStreamRepository implements LiveStreamRepository {
  constructor(
    @InjectModel(LiveStream) private readonly streams: typeof LiveStream,
    private readonly tx: TransactionRunner,
  ) {}

  async create(input: {
    shopId: string;
    title: string;
    launchEventId: string | null;
  }): Promise<LiveStreamRecord> {
    const row = await this.streams.create({ ...input, status: 'SCHEDULED' });
    return toRecord(row);
  }

  async findById(id: string): Promise<LiveStreamRecord | null> {
    const row = await this.streams.findByPk(id);
    return row ? toRecord(row) : null;
  }

  async transition(input: {
    id: string;
    shopId: string;
    from: LiveStatus;
    to: 'LIVE' | 'ENDED';
    at: Date;
  }): Promise<LiveStreamRecord | null> {
    const [affected, rows] = await this.streams.update(
      input.to === 'LIVE'
        ? { status: 'LIVE', startedAt: input.at }
        : { status: 'ENDED', endedAt: input.at, pin: null },
      {
        where: { id: input.id, shopId: input.shopId, status: input.from },
        returning: true,
      },
    );
    if (affected !== 1 || !rows[0]) return null;
    return toRecord(rows[0]);
  }

  changePin(
    id: string,
    shopId: string,
    decide: (current: LiveStreamRecord) => PinChange,
  ): Promise<{ record: LiveStreamRecord; changed: boolean } | null> {
    return this.tx.run(async () => {
      const row = await this.streams.findOne({
        where: { id, shopId },
        lock: true,
      });
      if (!row) return null;
      const change = decide(toRecord(row));
      if (change.kind === 'keep')
        return { record: toRecord(row), changed: false };
      await row.update({
        pin: change.kind === 'set' ? change.pin : null,
        pinVersion: row.pinVersion + 1,
      });
      return { record: toRecord(row), changed: true };
    });
  }

  async listLiveIds(): Promise<string[]> {
    const rows = await this.streams.findAll({
      attributes: ['id'],
      where: { status: 'LIVE' },
    });
    return rows.map((r) => r.id);
  }
}
