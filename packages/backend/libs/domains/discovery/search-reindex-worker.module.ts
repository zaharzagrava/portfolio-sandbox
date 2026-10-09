import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { SearchReindexService } from './application/search-reindex.service';

/** SD-37 alias reindex (apps/worker). */
@Module({
  imports: [
    SequelizeModule.forFeature([Product]),
    ElasticsearchModule,
    JobsModule,
  ],
  providers: [SearchReindexService],
  exports: [SearchReindexService],
})
export class SearchReindexWorkerModule {}
