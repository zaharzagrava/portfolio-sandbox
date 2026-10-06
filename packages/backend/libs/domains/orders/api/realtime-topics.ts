import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `job:{id}` for order exports (SD-27 progress): only the user who started it. Catalog-sync defines `job:` for imports; the registry ORs both. */
@Injectable()
export class ExportJobTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'job',
      policy: async (viewer, _topic, jobId) => {
        if (!viewer.userId) return false;
        const rows = await this.sequelize.query(`SELECT 1 FROM "ExportJob" WHERE id = :jobId AND "createdBy" = :userId LIMIT 1`, {
          type: QueryTypes.SELECT,
          replacements: { jobId, userId: viewer.userId },
        });
        return rows.length > 0;
      },
    });
  }
}
