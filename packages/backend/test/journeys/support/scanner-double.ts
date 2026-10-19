import { FakeClamd } from '@app/infrastructure/antivirus/testing/fake-clamd';

/** Default port of the scanner double; the local stack points `CLAMAV_HOST` at `127.0.0.1:18446`. */
export const SCANNER_DOUBLE_PORT = 18446;

/**
 * The malware scanner double of J04 (spec.md "Provider doubles"): it speaks the real clamd streaming protocol
 * (`zINSTREAM`, length-prefixed chunks, zero terminator, `stream: OK` / `stream: <Signature> FOUND`) and answers clean for
 * everything except content that holds the EICAR string. The stack's scanner stays mandatory; this is what it talks to.
 */
export class ScannerDouble extends FakeClamd {
  static async startDouble(
    port: number = Number(
      process.env.JOURNEY_SCANNER_PORT ?? SCANNER_DOUBLE_PORT,
    ),
  ): Promise<ScannerDouble> {
    const double = new ScannerDouble();
    double.port = port;
    await double.start();
    return double;
  }
}
