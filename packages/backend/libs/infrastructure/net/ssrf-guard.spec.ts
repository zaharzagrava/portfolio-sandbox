import { isPublicAddress, resolvePublicTarget, SsrfBlockedError } from './ssrf-guard';

/** Shared by webhooks (SD-30), the crawler (SD-35) and shop integrations (SD-36). */
describe('SSRF guard', () => {
  it.each([
    ['10.0.0.5', false],
    ['172.16.3.4', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false], // cloud metadata
    ['100.64.1.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false], // v4-mapped private
    ['8.8.8.8', true],
    ['172.32.0.1', true], // just outside 172.16/12
    ['2606:4700:4700::1111', true],
  ])('%s public=%s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('rejects non-https, credentials, odd ports and private literals; allows explicit local hosts for tests', async () => {
    await expect(resolvePublicTarget('http://example.com/hook')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolvePublicTarget('https://user:pw@example.com/')).rejects.toThrow('credentials');
    await expect(resolvePublicTarget('https://example.com:6379/')).rejects.toThrow('port');
    await expect(resolvePublicTarget('https://10.0.0.5/hook')).rejects.toThrow('non-public');
    await expect(resolvePublicTarget('https://[::1]/hook')).rejects.toThrow('non-public');
    await expect(resolvePublicTarget('https://169.254.169.254/latest/meta-data')).rejects.toThrow('non-public');
    const local = await resolvePublicTarget('http://127.0.0.1:4567/hook', { allowHttpHosts: ['127.0.0.1'], allowPrivateHosts: ['127.0.0.1'] });
    expect(local.address).toBe('127.0.0.1');
  });
});
