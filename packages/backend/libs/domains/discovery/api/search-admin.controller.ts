import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Firewall, Role } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

// 'search.reindex-products' payload type + contract live in search-reindex.job-types.ts (no handler code pulled in).
import '../application/search-reindex.job-types';
import { ShopProductSearchService } from '../application/shop-product-search.service';
import { SearchQualityService } from '../application/search-quality.service';

export class SearchClickDto {
  @ApiProperty() @IsString() @MaxLength(100) query: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsInt() @Min(0) position: number;
}

export class SynonymsDto {
  @ApiProperty({ example: ['airpods, earbuds'] })
  @IsArray()
  @ArrayMaxSize(5_000)
  @IsString({ each: true })
  @Matches(/^[\w\s,=>-]{1,200}$/, { each: true })
  rules: string[];
}

@ApiTags('search')
@Controller()
export class SearchAdminController {
  constructor(
    private readonly shopSearch: ShopProductSearchService,
    private readonly quality: SearchQualityService,
    private readonly es: ElasticsearchService,
    private readonly jobs: JobsService,
  ) {}

  @ShopScoped('products.read')
  @Get('shops/:shopId/products/search')
  shopProducts(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query('q') q = '',
  ) {
    return this.shopSearch.search(shopId, q.slice(0, 100));
  }

  @Firewall({ anonymous: true })
  @HttpCode(202)
  @Post('search/clicks')
  click(@Body() body: SearchClickDto) {
    this.quality.recordClick(body.query, body.productId, body.position);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/search/quality')
  report(@Query('days') days = '7') {
    return this.quality.report(Math.min(Number(days) || 7, 90));
  }

  /** Synonyms take effect immediately (search-time analyzer reload). */
  @Firewall({ roles: [Role.ADMIN] })
  @Put('admin/search/synonyms')
  synonyms(@Body() body: SynonymsDto) {
    return this.es.updateSynonyms(body.rules);
  }

  /** Mapping changes: zero-downtime rebuild behind the alias (runs on the worker). */
  @Firewall({ roles: [Role.ADMIN] })
  @HttpCode(202)
  @Post('admin/search/reindex')
  async reindex() {
    return {
      jobId: await this.jobs.enqueue(
        'search.reindex-products',
        {},
        {
          idempotencyKey: `search-reindex:${new Date().toISOString().slice(0, 13)}`,
        },
      ),
    };
  }
}
