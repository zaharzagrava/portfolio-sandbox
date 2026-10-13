import { Logger, Provider } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { Environment } from '@app/common/types';
import {
  EMAIL_PROVIDERS,
  PUSH_PROVIDERS,
  SMS_PROVIDERS,
  ChannelProvider,
} from '../domain/provider-ports';
import { PROVIDER_CHAINS, type ProviderChains } from '../domain/ports';
import { MemoryEmailProvider } from './providers/memory-email.provider';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { TwilioSmsProvider } from './providers/twilio-sms.provider';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { LogPushProvider, LogSmsProvider } from './providers/log.providers';
import { ChannelSender } from './providers/channel-sender';

const logger = new Logger('NotificationProviders');

const isProduction = (config: ApiConfigService) =>
  config.get('node_env') === Environment.production;

/**
 * Production never starts on a stand-in (FR-034, AS-54): a missing credential fails the boot naming the setting. The
 * same rule is declared in `libs/common/config/notifications-config.ts` and checked when the configuration loads; this
 * is the second line, at the place a stand-in would be chosen.
 */
function missingInProduction(channel: string, settings: string[]): never {
  throw new Error(
    `notifications: production needs a real ${channel} provider; set ${settings.join(', ')}`,
  );
}

function standIn<T extends ChannelProvider>(channel: string, provider: T): T {
  logger.warn(
    `notifications.provider.stand_in channel=${channel} provider=${provider.name} (nothing leaves this process)`,
  );
  return provider;
}

/** E-mail failover chain: `EMAIL_PROVIDER=memory` (dev/test), else SES when configured, then SMTP. */
export function emailProviderChain(
  config: ApiConfigService,
): ChannelProvider[] {
  const production = isProduction(config);
  if (config.get('email_provider') === 'memory') {
    if (production)
      missingInProduction('e-mail', ['ses_from_address', 'smtp_url']);
    return [standIn('email', new MemoryEmailProvider())];
  }
  const from =
    config.get('ses_from_address') ??
    'Marketplace <no-reply@marketplace.local>';
  if (production && !config.get('ses_from_address') && !config.get('smtp_url'))
    missingInProduction('e-mail', ['ses_from_address', 'smtp_url']);
  return [
    ...(config.get('ses_from_address')
      ? [new SesEmailProvider(from, config.get('aws_region') ?? 'eu-central-1')]
      : []),
    new SmtpEmailProvider(
      config.get('smtp_url') ?? 'smtp://localhost:1025',
      from,
    ),
  ];
}

export function smsProviderChain(config: ApiConfigService): ChannelProvider[] {
  const sid = config.get('twilio_account_sid');
  const token = config.get('twilio_auth_token');
  const from = config.get('twilio_from');
  if (sid && token && from)
    return [
      new TwilioSmsProvider(
        sid,
        token,
        from,
        `${config.get('backend_host')}/api/notifications/webhooks/twilio`,
      ),
    ];
  if (isProduction(config))
    missingInProduction('sms', [
      'twilio_account_sid',
      'twilio_auth_token',
      'twilio_from',
    ]);
  return [standIn('sms', new LogSmsProvider())];
}

export function pushProviderChain(config: ApiConfigService): ChannelProvider[] {
  const clientEmail = config.get('firebase_client_email');
  const privateKey = config.get('firebase_private_key');
  // Placeholder credentials (tests, fresh local setups) fall back to logging instead of crashing at boot.
  if (!clientEmail || !privateKey?.includes('PRIVATE KEY')) {
    if (isProduction(config))
      missingInProduction('push', [
        'firebase_client_email',
        'firebase_private_key',
      ]);
    return [standIn('push', new LogPushProvider())];
  }
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
}

/** Provider chains from config: real SDKs when credentials exist, local stand-ins outside production. Order = failover order. */
export const NOTIFICATION_PROVIDERS: Provider[] = [
  {
    provide: EMAIL_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: emailProviderChain,
  },
  {
    provide: SMS_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: smsProviderChain,
  },
  {
    provide: PUSH_PROVIDERS,
    inject: [ApiConfigService],
    useFactory: pushProviderChain,
  },
  {
    provide: PROVIDER_CHAINS,
    inject: [EMAIL_PROVIDERS, SMS_PROVIDERS, PUSH_PROVIDERS, CLOCK],
    useFactory: (
      email: ChannelProvider[],
      sms: ChannelProvider[],
      push: ChannelProvider[],
      clock: Clock,
    ): ProviderChains => ({
      email: new ChannelSender(email, clock),
      sms: new ChannelSender(sms, clock),
      push: new ChannelSender(push, clock),
    }),
  },
];
