import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CourierService } from '../application/courier.service';
import { DispatchService } from '../application/dispatch.service';
import { CITIES_KEY } from '../infra/delivery-workers';

class PointDto {
  @ApiProperty() @IsLatitude() lat: number;
  @ApiProperty() @IsLongitude() lng: number;
}

class TrackPointDto extends PointDto {
  @ApiProperty() @IsInt() ts: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() accuracy?: number;
}

export class RegisterCourierDto {
  @ApiProperty() @Matches(/^[a-z0-9-]{2,40}$/) city: string;
  @ApiProperty({ enum: ['bike', 'scooter', 'car'] })
  @IsIn(['bike', 'scooter', 'car'])
  vehicle: 'bike' | 'scooter' | 'car';
}

export class AvailabilityDto {
  @ApiProperty() @IsBoolean() available: boolean;
}

export class LocationsDto {
  @ApiProperty({ type: [TrackPointDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TrackPointDto)
  points: TrackPointDto[];
}

export class RequestDeliveryDto {
  @ApiProperty() @IsUUID() buyerId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orderId?: string;
  @ApiProperty() @IsString() @Length(2, 40) city: string;
  @ApiProperty() @ValidateNested() @Type(() => PointDto) pickup: PointDto;
  @ApiProperty() @ValidateNested() @Type(() => PointDto) dropoff: PointDto;
}

@ApiTags('delivery')
@Controller()
export class DeliveryController {
  constructor(
    private readonly couriers: CourierService,
    private readonly dispatch: DispatchService,
    private readonly redis: RedisService,
  ) {}

  @Firewall()
  @Post('couriers/me')
  async register(@User() user: UserRawDto, @Body() body: RegisterCourierDto) {
    await this.redis.client.sadd(CITIES_KEY, body.city);
    return this.couriers.register(user.id, body.city, body.vehicle);
  }

  @Firewall()
  @Put('couriers/me/availability')
  availability(@User() user: UserRawDto, @Body() body: AvailabilityDto) {
    return this.couriers.setAvailability(user.id, body.available);
  }

  /** Phones send a batch every ~4 s (≤ 20 points); keep-alive connection. */
  @Firewall()
  @Post('couriers/me/locations')
  @HttpCode(202)
  async locations(@User() user: UserRawDto, @Body() body: LocationsDto) {
    const courier = await this.couriers.get(user.id);
    return this.couriers.report(user.id, courier.city, body.points);
  }

  @ShopScoped('orders.manage')
  @Post('shops/:shopId/deliveries')
  request(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: RequestDeliveryDto,
  ) {
    return this.dispatch.request({ shopId, ...body });
  }

  /** Buyer, assigned courier, or the offered courier. Live updates: SSE `delivery:{id}`. */
  @Firewall()
  @Get('deliveries/:id')
  async get(@Param('id', ParseUUIDPipe) id: string, @User() user: UserRawDto) {
    const d = await this.dispatch.get(id);
    if (![d.buyerId, d.courierId, d.offeredCourierId].includes(user.id))
      throw new ForbiddenException();
    const position = d.courierId
      ? await this.couriers.position(d.city, d.courierId)
      : null;
    return { ...d, courierPosition: position };
  }

  @Firewall()
  @Post('deliveries/:id/accept')
  @HttpCode(200)
  accept(@Param('id', ParseUUIDPipe) id: string, @User() user: UserRawDto) {
    return this.dispatch.accept(id, user.id);
  }

  @Firewall()
  @Post('deliveries/:id/decline')
  @HttpCode(204)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ) {
    await this.dispatch.decline(id, user.id);
  }

  @Firewall()
  @Post('deliveries/:id/picked-up')
  @HttpCode(204)
  async pickedUp(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ) {
    await this.dispatch.pickUp(id, user.id);
  }

  @Firewall()
  @Post('deliveries/:id/delivered')
  @HttpCode(204)
  async delivered(
    @Param('id', ParseUUIDPipe) id: string,
    @User() user: UserRawDto,
  ) {
    await this.dispatch.deliver(id, user.id);
  }
}
