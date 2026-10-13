import type { Readable } from 'node:stream';
import { MalwareScanner, ScanResult } from './malware-scanner';

/** Non-production only (`media_scanner_disabled`): every file is reported clean. The module logs one warning at start. */
export class DisabledMalwareScanner extends MalwareScanner {
  scan(source: Readable): Promise<ScanResult> {
    source.resume(); // drain so the storage connection is released
    return Promise.resolve({ clean: true });
  }
}
