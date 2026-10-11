import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { PASSWORD_RESET_MAILER } from '@app/domains/identity';
import { TransactionalMailService } from './application/transactional-mail.service';

/** Binds identity's `PASSWORD_RESET_MAILER` port to the direct e-mail sender (global: identity may not import this domain). */
@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [
    TransactionalMailService,
    { provide: PASSWORD_RESET_MAILER, useExisting: TransactionalMailService },
  ],
  exports: [TransactionalMailService, PASSWORD_RESET_MAILER],
})
export class TransactionalMailModule {}
