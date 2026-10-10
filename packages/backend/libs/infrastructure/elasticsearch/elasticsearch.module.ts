import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { ElasticsearchService } from './elasticsearch.service';
import { SearchEngineClient } from './search-engine.client';

@Module({
  imports: [ApiConfigModule],
  providers: [ElasticsearchService, SearchEngineClient],
  exports: [ElasticsearchService, SearchEngineClient],
})
export class ElasticsearchModule {}
