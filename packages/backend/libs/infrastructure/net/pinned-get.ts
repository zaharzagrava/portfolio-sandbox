import http from 'node:http';
import https from 'node:https';
import { resolvePublicTarget } from './ssrf-guard';

export interface FetchResult {
  status: number;
  body: string;
  finalUrl: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * GET for untrusted URLs (crawler, link previews): SSRF guard + connection
 * pinned to the checked IP on EVERY hop (redirects are followed manually and
 * re-guarded - an open redirect to 169.254.169.254 dies here), hard timeout,
 * body capped (a 5 GB "product page" is truncated, not buffered).
 */
export async function getPinned(
  url: string,
  options: { userAgent: string; maxBytes?: number; timeoutMs?: number; maxRedirects?: number; ssrf?: { allowHttpHosts?: string[]; allowPrivateHosts?: string[] } },
): Promise<FetchResult> {
  const { maxBytes = 2 * 1024 * 1024, timeoutMs = 10_000, maxRedirects = 3 } = options;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolvePublicTarget(current, options.ssrf);
    const result = await new Promise<FetchResult>((resolve, reject) => {
      const req = (target.url.protocol === 'https:' ? https : http).get(
        target.url,
        { headers: { 'user-agent': options.userAgent, accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity' }, lookup: (_h, _o, cb) => cb(null, target.address, target.family), timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), finalUrl: current, headers: res.headers });
          res.on('end', done);
          res.on('close', done);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      current = new URL(String(result.headers.location), current).toString();
      continue;
    }
    return result;
  }
  throw new Error('too many redirects');
}
