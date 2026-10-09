import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { buffer } from 'node:stream/consumers';
import { timingSafeEqual } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { DeliveryLogService } from '../infra/delivery-log.service';
import { SuppressionService } from '../application/suppression.service';
import { NotificationPreferencesService } from '../application/preferences.service';
import { SnsMessage, SnsVerifier, twilioSignature } from './sns-verifier';

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail: { messageId: string };
  bounce?: {
    bounceType: 'Permanent' | 'Transient' | 'Undetermined';
    bouncedRecipients: { emailAddress: string }[];
  };
  complaint?: { complainedRecipients: { emailAddress: string }[] };
}

/** Provider → us callbacks. Each one authenticated by the provider's own signature scheme. */
@ApiExcludeController()
@Controller('notifications/webhooks')
export class NotificationWebhooksController {
  private readonly logger = new Logger(NotificationWebhooksController.name);

  constructor(
    private readonly sns: SnsVerifier,
    private readonly deliveryLog: DeliveryLogService,
    private readonly suppression: SuppressionService,
    private readonly preferences: NotificationPreferencesService,
    private readonly config: ApiConfigService,
  ) {}

  /** SES configuration-set events via SNS (bounce, complaint, delivery). SNS posts `text/plain` JSON. */
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
    const topic = this.config.get('ses_events_topic_arn');
    if (!topic || message.TopicArn !== topic)
      throw new ForbiddenException('Unexpected topic');
    if (!(await this.sns.verify(message)))
      throw new UnauthorizedException('Bad SNS signature');

    if (message.Type === 'SubscriptionConfirmation' && message.SubscribeURL) {
      // Host already validated by the signature check (it's inside the signed fields); confirm the subscription.
      await fetch(message.SubscribeURL, { signal: AbortSignal.timeout(5_000) });
      return { confirmed: true };
    }
    if (message.Type !== 'Notification') return { ignored: true };

    const event = JSON.parse(message.Message) as SesEvent;
    const kind = event.eventType ?? event.notificationType;
    if (kind === 'Bounce' && event.bounce) {
      const permanent = event.bounce.bounceType === 'Permanent';
      if (permanent)
        await this.suppression.suppress(
          'email',
          event.bounce.bouncedRecipients.map((r) => r.emailAddress),
          'hard-bounce',
        );
      await this.deliveryLog.updateByProviderId(
        'ses',
        event.mail.messageId,
        permanent ? 'bounced' : 'failed',
        event.bounce.bounceType,
      );
    } else if (kind === 'Complaint' && event.complaint) {
      await this.suppression.suppress(
        'email',
        event.complaint.complainedRecipients.map((r) => r.emailAddress),
        'complaint',
      );
      const deliveryId = await this.deliveryLog.updateByProviderId(
        'ses',
        event.mail.messageId,
        'complained',
      );
      // A spam complaint also switches marketing email off for that account.
      const userId = deliveryId
        ? (
            (await this.deliveryLog.get(deliveryId))?.get('user_id') as
              { toString(): string } | undefined
          )?.toString()
        : undefined;
      if (userId)
        await this.preferences.setPreference(
          userId,
          'marketing',
          'email',
          false,
        );
    } else if (kind === 'Delivery') {
      await this.deliveryLog.updateByProviderId(
        'ses',
        event.mail.messageId,
        'delivered',
      );
    }
    return { ok: true };
  }

  /** Twilio status callback (form-encoded), signed with X-Twilio-Signature. */
  @Post('twilio')
  @HttpCode(204)
  async twilio(
    @Headers('x-twilio-signature') signature: string | undefined,
    @Body() body: Record<string, string>,
  ) {
    const token = this.config.get('twilio_auth_token');
    if (!token || !signature) throw new UnauthorizedException();
    const url = `${this.config.get('backend_host')}/api/notifications/webhooks/twilio`;
    const expected = Buffer.from(twilioSignature(token, url, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new UnauthorizedException();

    const status = body.MessageStatus;
    if (status === 'delivered')
      await this.deliveryLog.updateByProviderId(
        'twilio',
        body.MessageSid,
        'delivered',
      );
    if (status === 'undelivered' || status === 'failed') {
      await this.deliveryLog.updateByProviderId(
        'twilio',
        body.MessageSid,
        'failed',
        body.ErrorCode,
      );
      // 21610: recipient replied STOP - legally binding opt-out.
      if (body.ErrorCode === '21610' && body.To)
        await this.suppression.suppress('sms', [body.To], 'sms-stop');
    }
  }
}
