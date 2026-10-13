import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  MalwareScanner,
  ScannerUnavailableError,
  ScanResult,
} from './malware-scanner';

/** Test double at the system edge: clean, infected, slow (hangs past the timeout) or down. */
export class FakeMalwareScanner extends MalwareScanner {
  mode: 'clean' | 'infected' | 'slow' | 'down' = 'clean';
  signature = 'Eicar-Test-Signature';
  scans = 0;

  async scan(
    source: Readable,
    { timeoutMs }: { timeoutMs: number },
  ): Promise<ScanResult> {
    this.scans += 1;
    // The fake owns the stream: a late storage error (checksum, reset) must not surface as an unhandled 'error' event.
    source.on('error', () => undefined);
    if (this.mode === 'down') {
      source.destroy();
      throw new ScannerUnavailableError('scanner refused the connection');
    }
    if (this.mode === 'slow') {
      source.destroy();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(timeoutMs, 50)),
      );
      throw new ScannerUnavailableError('scanner timed out');
    }
    if (this.mode === 'infected') {
      source.destroy();
      return { clean: false, signature: this.signature };
    }
    try {
      source.resume();
      await finished(source); // read the whole body, as a real engine does
    } catch (error) {
      throw new ScannerUnavailableError(
        `scanner could not read the object: ${(error as Error).message}`,
      );
    }
    return { clean: true };
  }
}
