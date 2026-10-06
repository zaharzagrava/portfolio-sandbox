import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ElasticsearchService } from './elasticsearch.service';

@Module({
  imports: [ApiConfigModule],
  providers: [ElasticsearchService],
  exports: [ElasticsearchService],
})
export class ElasticsearchModule { }
