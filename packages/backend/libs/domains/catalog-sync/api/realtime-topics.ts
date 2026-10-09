import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `job:{id}` for catalog imports (SD-27 progress): only the user who started it. Orders defines `job:` for exports; the registry ORs both. */
@Injectable()
export class ImportJobTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'job',
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
