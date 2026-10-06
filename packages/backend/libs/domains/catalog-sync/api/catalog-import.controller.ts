import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { ShopScoped } from '@app/domains/tenancy';
import { User, UserRawDto } from '@app/domains/identity';
import { CatalogImportService } from '../application/catalog-import.service';
import { OrderExportService } from '@app/domains/orders';

export class StartImportDto {
  @ApiProperty() @IsString() @Length(1, 200) fileName: string;
  @ApiProperty() @IsInt() @Min(1) @Max(5 * 1024 * 1024 * 1024) sizeBytes: number;
}

class PartDto {
  @ApiProperty() @IsInt() @Min(1) partNumber: number;
  @ApiProperty() @IsString() etag: string;
}

export class CompleteImportDto {
  @ApiProperty({ type: [PartDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PartDto) parts: PartDto[];
}

@ApiTags('catalog-import')
@Controller('shops/:shopId')
export class CatalogImportController {
  constructor(
    private readonly imports: CatalogImportService,
    private readonly exports: OrderExportService,
  ) {}

  @ShopScoped('products.write')
  @Post('imports')
  start(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto, @Body() body: StartImportDto) {
    return this.imports.start(shopId, user.id, body.fileName, body.sizeBytes);
  }

  @ShopScoped('products.write')
  @Post('imports/:jobId/complete')
  complete(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: CompleteImportDto) {
    return this.imports.complete(shopId, jobId, body.parts);
  }

  /** Live progress: SSE topic `job:{jobId}` (creator only). */
  @ShopScoped('products.read')
  @Get('imports/:jobId')
  status(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.imports.status(shopId, jobId);
  }

  @ShopScoped('orders.manage')
  @Post('exports/orders')
  export(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto) {
    return this.exports.request(shopId, user.id);
  }

  @ShopScoped('orders.manage')
  @Get('exports/:jobId')
  exportStatus(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.exports.status(shopId, jobId);
  }
}
