import { Global, Module } from '@nestjs/common';
import { FlagsClient } from './infra/flags.client';
import { FlagGuard } from './api/flags.guard';
import { ApiConfigModule } from '@app/common/config';

/** The local-evaluation SDK. Global: any module can inject FlagsClient / use @RequireFlag. Import once per app. */
@Global()
@Module({
  providers: [FlagsClient, FlagGuard],
  exports: [FlagsClient, FlagGuard],
  imports: [ApiConfigModule],
})
export class FlagsSdkModule {}
