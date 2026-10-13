import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  Device,
  DeviceList,
  RegisterDeviceRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { DeviceService } from '../application/device.service';
import { deviceIdParam, registerDeviceBody } from './notifications.dto';

/** Push devices of the signed-in user. A device is addressed by its id, never by its token. */
@ApiTags('notifications')
@Controller('notifications/devices')
export class DevicesController {
  constructor(private readonly devices: DeviceService) {}

  @Firewall()
  @RateLimit('notifications.read.user')
  @Get()
  list(@User() user: UserRawDto): Promise<DeviceList> {
    return this.devices.list(user.id);
  }

  @Firewall()
  @RateLimit('notifications.write.user')
  @Post()
  async register(
    @User() user: UserRawDto,
    @Body(registerDeviceBody) body: RegisterDeviceRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Device> {
    const { device, created } = await this.devices.register(user.id, body);
    res.status(created ? 201 : 200);
    return device;
  }

  @Firewall()
  @RateLimit('notifications.write.user')
  @Delete(':deviceId')
  @HttpCode(204)
  async remove(
    @User() user: UserRawDto,
    @Param(deviceIdParam) params: { deviceId: string },
  ): Promise<void> {
    await this.devices.remove(user.id, params.deviceId);
  }
}
