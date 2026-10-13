import { Logger, Module } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { ClamdMalwareScanner } from './clamd-scanner';
import { DisabledMalwareScanner } from './disabled-scanner';
import { MalwareScanner } from './malware-scanner';

export { ClamdMalwareScanner, scanStream } from './clamd-scanner';
export { DisabledMalwareScanner } from './disabled-scanner';
export { FakeMalwareScanner } from './fake-scanner';
export { MalwareScanner, ScannerUnavailableError } from './malware-scanner';
export type { ScanResult } from './malware-scanner';

/**
 * Chooses the adapter from configuration: clamd at `clamav_host`, or the disabled scanner when `media_scanner_disabled`
 * is set outside production (one warning at start). Production without an address fails startup in the config rules.
 */
@Module({
  imports: [ApiConfigModule],
  providers: [
    {
      provide: MalwareScanner,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): MalwareScanner => {
        const address = config.get('clamav_host');
        if (config.get('media_scanner_disabled') || !address) {
          new Logger('AntivirusModule').warn(
            'malware scanner is DISABLED: uploaded photos are not scanned (non-production only)',
          );
          return new DisabledMalwareScanner();
        }
        return ClamdMalwareScanner.fromAddress(address);
      },
    },
  ],
  exports: [MalwareScanner],
})
export class AntivirusModule {}
