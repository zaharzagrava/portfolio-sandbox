import { Global, Module } from '@nestjs/common';
import { ApiConfigService } from './api-config.service';
import { ConfigUtilsModule } from './config-utils/config-utils.module';
import { ConfigUtilsService } from './config-utils/config-utils.service';

@Global()
@Module({
  imports: [ConfigUtilsModule],
  providers: [
    {
      provide: ApiConfigService,
      inject: [ConfigUtilsService],
      useFactory: async (configUtilsService: ConfigUtilsService) => {
        const apiConfigService = new ApiConfigService(configUtilsService);
        await apiConfigService.init();
        return apiConfigService;
      },
    },
  ],
  exports: [ApiConfigService],
})
export class ApiConfigModule {}
