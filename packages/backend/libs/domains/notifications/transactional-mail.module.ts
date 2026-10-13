import { Global, Module } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { PASSWORD_RESET_MAILER } from '@app/domains/identity';
import { TransactionalMailService } from './application/transactional-mail.service';
import { TRANSACTIONAL_MAIL_CHAIN } from './domain/ports';
import { emailProviderChain } from './infra/notification-providers';
import { ChannelSender } from './infra/providers/channel-sender';

/** Binds identity's `PASSWORD_RESET_MAILER` port to the direct e-mail sender (global: identity may not import this domain). */
@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [
    {
      provide: TRANSACTIONAL_MAIL_CHAIN,
      inject: [ApiConfigService, CLOCK],
      useFactory: (config: ApiConfigService, clock: Clock) =>
        new ChannelSender(emailProviderChain(config), clock),
    },
    TransactionalMailService,
    { provide: PASSWORD_RESET_MAILER, useExisting: TransactionalMailService },
  ],
  exports: [TransactionalMailService, PASSWORD_RESET_MAILER],
})
export class TransactionalMailModule {}
