import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { buffer } from 'node:stream/consumers';
import { timingSafeEqual } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CallbackIntakeService } from '../application/callback-intake.service';
import { SnsMessage, SnsVerifier, twilioSignature } from './sns-verifier';

/**
 * Provider → us callbacks. Each one authenticated by the provider's own signature scheme, then durably accepted and
 * acknowledged; applying the effects is the callback worker's (AS-70). No user session: the signature is the
 * credential. Rate limited per address, fail open (a flood is bounded, a complaint is never dropped).
 */
@ApiExcludeController()
@Controller('notifications/webhooks')
export class NotificationWebhooksController {
  constructor(
    private readonly sns: SnsVerifier,
    private readonly intake: CallbackIntakeService,
    private readonly config: ApiConfigService,
  ) {}

  /** SES configuration-set events via SNS (bounce, complaint, delivery). SNS posts `text/plain` JSON. */
  @Firewall({ anonymous: true })
  @RateLimit('notifications.webhook.ip')
  @Post('ses')
  @HttpCode(200)
  async ses(@Req() req: Request & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? (await buffer(req));
    let message: SnsMessage;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('Not JSON');
    }
    if (typeof message !== 'object' || message === null)
      throw new BadRequestException('Not an SNS message');
    const topic = this.config.get('ses_events_topic_arn');
    if (!topic || message.TopicArn !== topic)
      throw new ForbiddenException('Unexpected topic');
    if (!(await this.sns.verify(message)))
      throw new UnauthorizedException('Bad SNS signature');

    if (message.Type === 'SubscriptionConfirmation') {
      // The URL is inside the signed fields, but a signed message from the pinned topic is still only trusted to
      // point at the provider's own HTTPS host.
      const url = this.intake.assertSubscribeUrl(message.SubscribeURL);
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return { confirmed: true };
    }
    if (message.Type !== 'Notification') return { ignored: true };

    const result = await this.intake.acceptSes(
      message.MessageId,
      message.Message,
    );
    return { [result]: true };
  }

  /** Twilio status callback (form-encoded), signed with X-Twilio-Signature. */
  @Firewall({ anonymous: true })
  @RateLimit('notifications.webhook.ip')
  @Post('twilio')
  @HttpCode(204)
  async twilio(
    @Headers('x-twilio-signature') signature: string | undefined,
    @Body() body: Record<string, string>,
  ) {
    const token = this.config.get('twilio_auth_token');
    if (!token || !signature) throw new UnauthorizedException();
    const url = `${this.config.get('backend_host')}/api/notifications/webhooks/twilio`;
    const expected = Buffer.from(twilioSignature(token, url, body ?? {}));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new UnauthorizedException();

    await this.intake.acceptSms(body ?? {});
  }
}
