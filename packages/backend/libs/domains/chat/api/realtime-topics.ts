import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        // the id reaches SQL: refuse anything that is not a UUID before it does (G-26)
        if (!viewer.userId || !UUID.test(channelId)) return false;
        const rows = await this.sequelize.query(
          `SELECT 1 FROM "ChatChannelMember" WHERE "channelId" = :channelId AND "userId" = :userId AND status = 'ACTIVE'`,
          {
            type: QueryTypes.SELECT,
            replacements: { channelId, userId: viewer.userId },
          },
        );
        return rows.length > 0;
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    chat: `chat:${string}`;
  }
}
