import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { MalwareScanner } from '@app/infrastructure/antivirus';
import { IMPORT_CONFIG, type ImportConfig } from '../domain/import-limits';
import type { ImportScannerPort, ImportScanVerdict } from '../domain/ports';

/**
 * The shared `MalwareScanner` (`@app/infrastructure/antivirus`, S29) for an import's source: a 60 second inactivity
 * limit and a 30 minute total, both configurable. Fail closed: a scanner that is down, stalled or confused throws
 * `ScannerUnavailableError` and no file passes. When the scanner is explicitly disabled (non-production only) nothing is
 * read and the verdict is `skipped`. The infected signature is returned to the runner, which logs it and nothing else.
 */
@Injectable()
export class ImportScannerAdapter implements ImportScannerPort {
  constructor(
    private readonly scanner: MalwareScanner,
    @Inject(IMPORT_CONFIG) private readonly config: ImportConfig,
  ) {}

  async scan(
    source: Readable,
    options: { signal?: AbortSignal },
  ): Promise<ImportScanVerdict> {
    if (this.scanner.kind === 'disabled') {
      source.destroy();
      return { kind: 'clean', scan: 'skipped' };
    }
    const stop = () => source.destroy();
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      const result = await this.scanner.scan(source, {
        timeoutMs: this.config.scanTotalMs,
        inactivityMs: this.config.scanInactivityMs,
      });
      return result.clean
        ? { kind: 'clean', scan: 'clean' }
        : { kind: 'infected', signature: result.signature };
    } finally {
      options.signal?.removeEventListener('abort', stop);
      if (!source.destroyed) source.destroy();
    }
  }
}
