import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream';
import { SensitivePathParams } from '@app/common/exceptions-filter';
import { Firewall } from '@app/domains/identity';
import { DeliveryService } from '../application/delivery.service';
import { addressOf } from './share.controller';

/**
 * `GET /downloads/:token` (S31 FR-036, FR-037): bytes for a grant, no state change, attachment headers. The first chunk is
 * opened before any header is sent, so a storage failure is a clean `503`; a failure after that aborts the connection,
 * which the client sees as fewer bytes than `Content-Length`.
 */
@ApiTags('assets')
@Controller()
export class DownloadsController {
  constructor(private readonly delivery: DeliveryService) {}

  @Firewall({ anonymous: true })
  @SensitivePathParams('token')
  @Get('downloads/:token')
  async download(
    @Param('token') token: string,
    @Req() req: Request & { clientIp?: string },
    @Res() res: Response,
  ): Promise<void> {
    const { headers, body } = await this.delivery.open(token, addressOf(req));
    res.removeHeader('Set-Cookie');
    res.status(200);
    for (const [name, value] of Object.entries(headers))
      res.setHeader(name, value);
    pipeline(body, res, (error) => {
      // headers are sent: the only honest signal left is to cut the connection
      if (error) res.destroy();
    });
  }
}
