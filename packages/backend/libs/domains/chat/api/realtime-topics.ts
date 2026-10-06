import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `chat:{channelId}` (SD-14 receipts + presence): active channel members only. */
@Injectable()
export class ChatTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'chat',
      policy: async (viewer, _topic, channelId) => {
        if (!viewer.userId) return false;
        const rows = await this.sequelize.query(`SELECT 1 FROM "ChatChannelMember" WHERE "channelId" = :channelId AND "userId" = :userId AND status = 'ACTIVE'`, {
          type: QueryTypes.SELECT,
          replacements: { channelId, userId: viewer.userId },
        });
        return rows.length > 0;
      },
    });
  }
}
