import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime';

/** `import:{id}` for catalog imports (SD-27 progress): only the user who started it (S07). */
@Injectable()
export class ImportJobTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'import',
      policy: async (viewer, _topic, jobId) => {
        if (!viewer.userId) return false;
        const rows = await this.sequelize.query(
          `SELECT 1 FROM "ImportJob" WHERE id = :jobId AND "createdBy" = :userId LIMIT 1`,
          {
            type: QueryTypes.SELECT,
            replacements: { jobId, userId: viewer.userId },
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
    import: `import:${string}`;
  }
}
