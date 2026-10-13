import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { UnsubscribeService } from '../application/unsubscribe.service';
import { UnsubscribeTokenPipe } from './notifications.dto';

/**
 * Anonymous, rate limited per address. GET only DESCRIBES the unsubscribe (the web page renders a confirm button):
 * corporate mail scanners pre-fetch every link in an email, and a GET that unsubscribed would silently opt people out.
 * POST performs it - that is also what RFC 8058 one-click clients send.
 */
@ApiTags('notifications')
@Controller('notifications/unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Firewall({ anonymous: true })
  @RateLimit('notifications.unsubscribe.ip')
  @Get()
  describe(@Query('token', new UnsubscribeTokenPipe()) token: string) {
    return this.unsubscribe.describe(token);
  }

  @Firewall({ anonymous: true })
  @RateLimit('notifications.unsubscribe.ip')
  @Post()
  @HttpCode(200)
  perform(@Query('token', new UnsubscribeTokenPipe()) token: string) {
    return this.unsubscribe.perform(token);
  }
}
