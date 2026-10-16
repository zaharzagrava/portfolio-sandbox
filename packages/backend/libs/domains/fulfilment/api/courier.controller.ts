import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  availabilityRequestSchema,
  locationBatchRequestSchema,
  registerCourierRequestSchema,
  type AvailabilityRequest,
  type CourierSelf,
  type CourierView,
  type LocationBatchRequest,
  type LocationBatchResponse,
  type RegisterCourierRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CourierService } from '../application/courier.service';
import { LocationIngestService } from '../application/location-ingest.service';
import { DeliveryZodPipe } from './delivery-zod.pipe';
import { LocationBodyGuard } from './location-body.guard';

const registerBody = new DeliveryZodPipe(registerCourierRequestSchema);
const availabilityBody = new DeliveryZodPipe(availabilityRequestSchema);
const locationsBody = new DeliveryZodPipe(locationBatchRequestSchema);

/**
 * The courier's own profile, shift and position (S20 FR-001..FR-012). The courier is the session's user: there is no
 * courier id in any path or body. One service call per method.
 */
@ApiTags('delivery')
@Controller('couriers/me')
export class CourierController {
  constructor(
    private readonly couriers: CourierService,
    private readonly ingest: LocationIngestService,
  ) {}

  /** 201 for a first registration, 200 for an update. */
  @Firewall()
  @Post()
  async register(
    @User() user: UserRawDto,
    @Body(registerBody) body: RegisterCourierRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CourierView> {
    const { created, courier } = await this.couriers.register(user.id, body);
    res.status(created ? 201 : 200);
    return courier;
  }

  @Firewall()
  @Get()
  self(@User() user: UserRawDto): Promise<CourierSelf> {
    return this.couriers.getSelf(user.id);
  }

  @Firewall()
  @Put('availability')
  availability(
    @User() user: UserRawDto,
    @Body(availabilityBody) body: AvailabilityRequest,
  ): Promise<CourierView> {
    return this.couriers.setAvailability(user.id, body.available);
  }

  /** Phones send a batch every ~4 s (at most 20 points, 32 KB) on a keep-alive connection. */
  @UseGuards(LocationBodyGuard) // runs after the authentication guard (decorators apply bottom-up)
  @Firewall()
  @RateLimit('fulfilment.courier-locations')
  @Post('locations')
  @HttpCode(202)
  locations(
    @User() user: UserRawDto,
    @Body(locationsBody) body: LocationBatchRequest,
  ): Promise<LocationBatchResponse> {
    return this.ingest.ingest(user.id, body);
  }
}
