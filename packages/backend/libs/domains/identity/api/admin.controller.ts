import {
  Controller,
  Post,
  Logger,
  ForbiddenException,
  Body,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import { AdminService } from '../application/admin.service';
import { DbCredsDto } from './admin.dto';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  private readonly l = new Logger(AdminController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly configService: ApiConfigService,
  ) {}

  @Post('/external-db-sync')
  async externalDbSync(@Body() body: DbCredsDto) {
    this.l.log('--- sync external db into local db ---');

    if (![Environment.local].includes(this.configService.get('node_env'))) {
      throw new ForbiddenException();
    }

    await this.adminService.externalDbSync(body);
  }
}
