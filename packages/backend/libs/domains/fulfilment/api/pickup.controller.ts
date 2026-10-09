import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Firewall } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { PickupService } from '../application/pickup.service';
import { AvailabilityIndex } from '../infra/availability-index';

export class CreatePickupPointDto {
  @ApiProperty() @IsString() @MaxLength(120) name: string;
  @ApiProperty() @IsString() @MaxLength(300) address: string;
  @ApiProperty() @IsLatitude() lat: number;
  @ApiProperty() @IsLongitude() lng: number;
}

export class SetStockDto {
  @ApiProperty() @IsInt() @Min(0) quantity: number;
}

export class NearQueryDto {
  @ApiProperty() @IsLatitude() lat: number;
  @ApiProperty() @IsLongitude() lng: number;
  @ApiPropertyOptional({ default: 5 }) @IsOptional() radiusKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
}

const clampRadius = (r?: number) => Math.min(Math.max(Number(r ?? 5), 0.1), 50);

@ApiTags('pickup')
@Controller()
export class PickupController {
  constructor(
    private readonly pickup: PickupService,
    private readonly availability: AvailabilityIndex,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/pickup-points')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreatePickupPointDto,
  ) {
    return this.pickup.createPoint(shopId, body);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/pickup-points/:pointId/stock/:productId')
  setStock(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: SetStockDto,
  ) {
    return this.pickup.setStock(shopId, pointId, productId, body.quantity);
  }

  /** "AirPods available for pickup within 5 km" - Elasticsearch, eventually consistent. */
  @Firewall({ anonymous: true })
  @RateLimit('search.query')
  @Get('search/near')
  searchNear(@Query() query: NearQueryDto) {
    return this.availability.searchNear({
      q: query.q,
      lat: Number(query.lat),
      lng: Number(query.lng),
      radiusKm: clampRadius(query.radiusKm),
    });
  }

  /** Pickup points within a radius - PostGIS, exact. */
  @Firewall({ anonymous: true })
  @RateLimit('search.query')
  @Get('pickup-points/near')
  near(@Query() query: NearQueryDto, @Query('productId') productId?: string) {
    return this.pickup.near(
      Number(query.lat),
      Number(query.lng),
      clampRadius(query.radiusKm),
      productId,
    );
  }

  @Firewall({ anonymous: true, skipThrottle: true })
  @Header('Cache-Control', 'public, s-maxage=30')
  @Get('pickup-points/clusters')
  clusters(@Query('bbox') bbox: string, @Query('zoom') zoom = '10') {
    const [top, left, bottom, right] = (bbox ?? '').split(',').map(Number);
    if ([top, left, bottom, right].some((n) => !Number.isFinite(n)))
      throw new BadRequestException('bbox=top,left,bottom,right');
    return this.availability.clusters(
      { top, left, bottom, right },
      Number(zoom),
    );
  }
}
