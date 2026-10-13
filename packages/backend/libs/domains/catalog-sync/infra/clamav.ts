/**
 * The clamd client moved to `libs/infrastructure/antivirus` (S29, constitution X.3: `media` must not import
 * `catalog-sync`). This file stays as a re-export so S07 keeps working untouched; S07 can import the library directly
 * and delete it (follow-up in the S29 gaps).
 */
export { scanStream } from '@app/infrastructure/antivirus/clamd-scanner';
export type { ScanResult } from '@app/infrastructure/antivirus/malware-scanner';
