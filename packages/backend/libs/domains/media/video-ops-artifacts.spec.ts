import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AS-60 is an operations scenario and SC-006 / SC-008 are rate and propagation figures: the deployed bucket, the CDN
 * behaviors and the load cannot be proven by an API test (they are rows in `specs/UNVERIFIED.md`, status "not run").
 * What a unit spec can prove is that the artifacts that run them exist and say what the scenario says, so a rename or
 * an edit that drops a rule fails here.
 */
const root = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('S30 operations artifacts (declared, not run)', () => {
  const terraform = read('infra/modules/s3_cloudfront/main.tf');

  it('S30 AS-60: the video host has a public path, a signed unlisted path, and nothing else reachable', () => {
    expect(terraform).toMatch(/resource "aws_cloudfront_distribution" "video"/);
    expect(terraform).toMatch(/path_pattern\s*=\s*"p\/\*"/);
    expect(terraform).toMatch(/path_pattern\s*=\s*"u\/\*"/);
    // the default behavior and the unlisted path need a signature
    expect(
      (
        terraform.match(
          /trusted_key_groups\s*=\s*\[aws_cloudfront_key_group\.signing\.id\]/g,
        ) ?? []
      ).length,
    ).toBeGreaterThanOrEqual(3);
    // the bucket policy grants the video distribution the two delivery prefixes and never the source prefix
    expect(terraform).toContain('/p/*');
    expect(terraform).toContain('/u/*');
    expect(terraform).not.toMatch(/arn\}\/vsrc/);
  });

  it('S30 AS-60: nosniff and the immutable header on both paths, CORS with credentials on the unlisted path only', () => {
    expect(terraform).toMatch(/video_public/);
    expect(terraform).toMatch(/video_unlisted/);
    expect(terraform).toMatch(/access_control_allow_credentials = false/);
    expect(terraform).toMatch(/access_control_allow_credentials = true/);
    expect(terraform).toContain('public, max-age=31536000, immutable');
  });

  it('S30 AS-60: incomplete multipart uploads are aborted after 2 days and sources move to infrequent access after 30', () => {
    expect(terraform).toMatch(/days_after_initiation\s*=\s*2/);
    expect(terraform).toMatch(/filter \{ prefix = "vsrc\/" \}/);
    expect(terraform).toMatch(/days\s*=\s*30\s+storage_class = "STANDARD_IA"/);
  });

  it('S30 AS-60: the post-deploy check asserts every header and refusal of the scenario and fails on drift', () => {
    const script = read('scripts/ops/check-video-edge.sh');
    for (const needle of [
      'application/vnd.apple.mpegurl',
      'nosniff',
      'max-age=31536000',
      'immutable',
      'set-cookie',
      'access-control-allow-credentials',
      '/u/$unlisted/master.m3u8',
      '/vsrc/$public/source',
      'exit 1',
      'set -euo pipefail',
    ])
      expect(script).toContain(needle);
  });

  it('S30 SC-006: the playback load script asks for 1,000 requests a second with a 150 ms p95 threshold', () => {
    const k6 = read('packages/backend/scripts/load-tests/video-playback.k6.js');
    expect(k6).toMatch(/RATE \|\| 1000/);
    expect(k6).toContain(
      "'http_req_duration{name:GET /api/videos/:id/playback}': ['p(95)<150']",
    );
  });
});
