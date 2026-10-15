import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { rawBodyRoutes } from '@app/infrastructure/platform/body-limits';
import { WebhookService } from '../application/webhook.service';

// The route reads the exact bytes (signature over them, A20); a body the platform would refuse as malformed JSON reaches
// the signature check and is answered like any other bad signature (AS-27). 1 MiB, the platform default, is the limit.
rawBodyRoutes.register({
  match: /^\/api\/integrations\/[^/]+\/webhooks$/,
  limit: '1mb',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Anonymous provider callback (contracts/http-api.md): authenticated by the provider's signature only, on its own
 * controller beside the shop-scoped routes. Per address (before the signature is looked at) and per integration limits
 * fail open: a limiter outage never loses a webhook (AS-32).
 */
@ApiTags('integrations')
@Controller('integrations/:integrationId/webhooks')
export class IntegrationWebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Firewall({ anonymous: true })
  @RateLimit('catalog-sync.webhook.ip', {
    policy: 'catalog-sync.webhook.integration',
    subject: (req) => {
      const id = (req.params as Record<string, string | undefined>)
        .integrationId;
      return id && UUID.test(id) ? id.toLowerCase() : null;
    },
  })
  @HttpCode(200)
  @Post()
  async receive(
    @Param('integrationId') integrationId: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ received: true }> {
    await this.webhooks.accept(integrationId, req.headers, req.rawBody);
    return { received: true };
  }
}
