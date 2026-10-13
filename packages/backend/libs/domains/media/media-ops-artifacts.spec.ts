import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AS-60 and AS-61 are operations scenarios: the deployed bucket, the CDN headers and the load figures cannot be proven by
 * an API test (they are rows in `specs/UNVERIFIED.md`, status "not run"). What a unit spec can prove is that the artifacts
 * that run them exist and say what the scenario says, so a rename or an edit that drops a number fails here.
 */
const root = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('S29 operations artifacts (declared, not run)', () => {
  const terraform = read('infra/modules/s3_cloudfront/main.tf');

  it('S29 AS-60: the infrastructure code tiers originals at 30 and 180 days, aborts incomplete uploads and keeps originals unreachable', () => {
    expect(terraform).toMatch(/filter \{ prefix = "media\/originals\/" \}/);
    expect(terraform).toMatch(/days\s*=\s*30\s+storage_class = "STANDARD_IA"/);
    expect(terraform).toMatch(/days\s*=\s*180\s+storage_class = "GLACIER"/);
    expect(terraform).toMatch(/abort_incomplete_multipart_upload/);
    expect(terraform).toMatch(/block_public_acls\s*=\s*true/);
    // only derived images and playlists are readable through the CDN
    expect(terraform).toMatch(/media\/derived\/\*/);
    expect(terraform).not.toMatch(/media\/originals\/\*"\]/);
  });

  it('S29 AS-60: the media origin is given nosniff and the immutable cache header, and no cookie reaches the cache key', () => {
    expect(terraform).toMatch(/content_type_options \{ override = true \}/);
    expect(terraform).toContain('public, max-age=31536000, immutable');
    expect(terraform).toMatch(
      /response_headers_policy_id\s*=\s*aws_cloudfront_response_headers_policy\.media\.id/,
    );
    expect(terraform).toContain('Managed-CachingOptimized');
  });

  it('S29 AS-60: the post-deploy check asserts every header of the scenario and fails on drift', () => {
    const script = read('scripts/ops/check-media-origin.sh');
    for (const needle of [
      'image/webp',
      'nosniff',
      'max-age=31536000',
      'immutable',
      'set-cookie',
      'exit 1',
      'set -euo pipefail',
    ])
      expect(script).toContain(needle);
  });

  it('S29 AS-61: the presign load script asks for 600 requests a second with a 300 ms p95 threshold and sends no image', () => {
    const k6 = read('packages/backend/scripts/load-tests/media-presign.k6.js');
    expect(k6).toMatch(/RATE \|\| 600/);
    expect(k6).toContain(
      "'http_req_duration{name:POST /api/media/uploads}': ['p(95)<300']",
    );
    expect(k6).not.toMatch(/FormData|multipart/i);
  });

  it('S29 AS-61: the throughput script takes the image count, the worker counts and the metadata check', () => {
    const script = read(
      'packages/backend/scripts/load-tests/media-throughput.mjs',
    );
    for (const needle of [
      'args.images',
      'args.workers',
      "'verify-metadata'",
      'uploadToReadyP95Seconds',
      'createMediaProcessor',
    ])
      expect(script).toContain(needle);
  });
});
