import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { ClientFlagsService } from './application/client-flags.service';
import { EvalContextService } from './application/eval-context.service';
import { FlagsClient } from './application/flags-client.service';
import { FlagGuard } from './api/flags.guard';
import { FlagsStoresModule } from './flags-stores.module';

/** The local-evaluation SDK. Global: any module can inject FlagsClient / use @RequireFlag. Import once per app. */
@Global()
@Module({
  imports: [ApiConfigModule, RealtimeModule, FlagsStoresModule],
  providers: [FlagsClient, FlagGuard, EvalContextService, ClientFlagsService],
  exports: [FlagsClient, FlagGuard, EvalContextService, ClientFlagsService],
})
export class FlagsSdkModule {}
