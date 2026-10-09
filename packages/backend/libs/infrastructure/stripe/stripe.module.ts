import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { StripeService } from './stripe.service';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';

@Module({
  imports: [ApiConfigModule, ErrorUtilsModule],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
