/**
 * The fake scanner server of the import specs (S07 test-plan: a system-edge fake that speaks the real clamd streaming
 * protocol over TCP). It lives with the antivirus library so the library's own protocol spec and these e2e specs use the
 * same server; this file is the domain's door to it.
 */
export {
  FakeClamd,
  type FakeClamdMode,
} from '@app/infrastructure/antivirus/testing/fake-clamd';
