import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ClientFlags } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ClientFlagsService } from '../application/client-flags.service';
import { factsFromRequest } from './request-context';

/** `GET /api/flags`: public, one call; the answer depends on the caller, so it is never shared-cached (FR-040). */
@ApiTags('flags')
@Controller()
export class FlagsClientController {
  constructor(
    private readonly clientFlags: ClientFlagsService,
    private readonly config: ApiConfigService,
  ) {}

  @Firewall({ anonymous: true })
  @RateLimit('flags.client.read')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization, X-Anonymous-Id')
  @Get('flags')
  evaluate(
    @Req() req: Parameters<typeof factsFromRequest>[0],
  ): Promise<ClientFlags> {
    return this.clientFlags.forRequest(
      factsFromRequest(req, this.config.get('flags_edge_secret')),
    );
  }
}
