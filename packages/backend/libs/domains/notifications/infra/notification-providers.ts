import { Provider } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { ApiConfigService } from '@app/common/config';
import {
  EMAIL_PROVIDERS,
  PUSH_PROVIDERS,
  SMS_PROVIDERS,
  ChannelProvider,
} from '../domain/provider-ports';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { TwilioSmsProvider } from './providers/twilio-sms.provider';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { LogPushProvider, LogSmsProvider } from './providers/log.providers';

/** Provider chains from config: real SDKs when credentials exist, local stand-ins otherwise. Order = failover order. */
export const NOTIFICATION_PROVIDERS: Provider[] = [
  {
    provide: EMAIL_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: (config: ApiConfigService): ChannelProvider[] => {
      const from =
        config.get('ses_from_address') ??
        'Marketplace <no-reply@marketplace.local>';
      return [
        ...(config.get('ses_from_address')
          ? [
              new SesEmailProvider(
                from,
                config.get('aws_region') ?? 'eu-central-1',
              ),
            ]
          : []),
        new SmtpEmailProvider(
          config.get('smtp_url') ?? 'smtp://localhost:1025',
          from,
        ),
      ];
    },
  },
  {
    provide: SMS_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: (config: ApiConfigService): ChannelProvider[] => {
      const sid = config.get('twilio_account_sid');
      const token = config.get('twilio_auth_token');
      const from = config.get('twilio_from');
      return sid && token && from
        ? [
            new TwilioSmsProvider(
              sid,
              token,
              from,
              `${config.get('backend_host')}/api/notifications/webhooks/twilio`,
            ),
          ]
        : [new LogSmsProvider()];
    },
  },
  {
    provide: PUSH_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: (config: ApiConfigService): ChannelProvider[] => {
      const clientEmail = config.get('firebase_client_email');
      const privateKey = config.get('firebase_private_key');
      // Placeholder credentials (tests, fresh local setups) fall back to logging instead of crashing at boot.
      if (!clientEmail || !privateKey?.includes('PRIVATE KEY'))
        return [new LogPushProvider()];
      const app =
        getApps().find((a) => a.name === 'notifications') ??
        initializeApp(
          {
            credential: cert({
              clientEmail,
              privateKey,
              projectId: config.get('firebase_project_id'),
            }),
          },
          'notifications',
        );
      return [new FcmPushProvider(app)];
    },
  },
];
