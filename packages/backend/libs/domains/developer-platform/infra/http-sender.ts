import http from 'node:http';
import https from 'node:https';
import { ResolvedTarget } from '@app/infrastructure/net/ssrf-guard';

export interface SendResult {
  status: number;
  durationMs: number;
  snippet: string;
  error?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024;

/**
 * POST to an SSRF-validated target with the connection PINNED to the address
 * the guard approved (`lookup` override - TLS still verifies the hostname via
 * SNI/cert). Redirects are not followed (a 3xx counts as a failure: following
 * it would bypass the guard). Hard 10 s timeout; response body read capped at 1 KB.
 */
export function postPinned(target: ResolvedTarget, body: string, headers: Record<string, string>): Promise<SendResult> {
  const started = Date.now();
  const transport = target.url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(
      target.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString(), 'User-Agent': 'Marketplace-Webhooks/1.0', ...headers },
        lookup: (_host, _opts, cb) => cb(null, target.address, target.family),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let snippet = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (snippet.length < MAX_RESPONSE_BYTES) snippet += chunk.slice(0, MAX_RESPONSE_BYTES - snippet.length);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, durationMs: Date.now() - started, snippet }));
        res.on('error', (e) => resolve({ status: res.statusCode ?? 0, durationMs: Date.now() - started, snippet, error: e.message }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${TIMEOUT_MS} ms`)));
    req.on('error', (e) => resolve({ status: 0, durationMs: Date.now() - started, snippet: '', error: e.message }));
    req.end(body);
  });
}
