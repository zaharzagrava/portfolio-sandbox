import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import type { LiveMuteRepository } from '../domain/live-ports';
import LiveMute from './models/live-mute.model';

@Injectable()
export class SequelizeLiveMuteRepository implements LiveMuteRepository {
  constructor(@InjectModel(LiveMute) private readonly mutes: typeof LiveMute) {}

  async mute(
    streamId: string,
    userId: string,
    mutedBy: string,
    at: Date,
  ): Promise<void> {
    await this.mutes.bulkCreate([{ streamId, userId, mutedBy, mutedAt: at }], {
      ignoreDuplicates: true,
    });
  }

  async unmute(streamId: string, userId: string): Promise<void> {
    await this.mutes.destroy({ where: { streamId, userId } });
  }

  async listByStream(streamId: string): Promise<string[]> {
    const rows = await this.mutes.findAll({
      attributes: ['userId'],
      where: { streamId },
    });
    return rows.map((r) => r.userId);
  }
}
