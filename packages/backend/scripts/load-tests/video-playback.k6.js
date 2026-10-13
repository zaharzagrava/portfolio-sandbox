// S30 SC-006 / AS-60 - playback under load: 1,000 requests per second for two minutes against one `READY` video.
//
//   k6 run -e API=https://api.staging.example -e VIDEO_ID=<uuid of a READY public video> scripts/load-tests/video-playback.k6.js
//   k6 run -e API=... -e VIDEO_ID=<unlisted video> -e TOKEN=<its share token> scripts/load-tests/video-playback.k6.js
//
// One iteration = one anonymous `GET /api/videos/:id/playback`. The answer is the JSON body (a few hundred bytes), no
// cookie for a public video, no database write (AS-40 proves that rule; this proves the rate). The limiter is
// `video.playback.ip` (600 a minute per address), so a real run spreads the load over many source addresses or
// raises the limit on the staging environment; a 429 is a clean refusal and is counted, not failed.
// SLO: p95 < 150 ms at 1,000 req/s. This is an ops artifact (specs/UNVERIFIED.md): the automated suite proves
// correctness, not the rate.
import http from 'k6/http';
import { check } from 'k6';

const api = (__ENV.API || 'http://localhost:3000').replace(/\/$/, '');
const videoId = __ENV.VIDEO_ID;
const token = __ENV.TOKEN;
const rate = Number(__ENV.RATE || 1000);

export const options = {
  scenarios: {
    playback: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Math.min(rate, 1000),
      maxVUs: Math.min(rate * 3, 5000),
    },
  },
  thresholds: {
    'http_req_duration{name:GET /api/videos/:id/playback}': ['p(95)<150'],
    'http_req_failed{name:GET /api/videos/:id/playback}': ['rate<0.001'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  if (!videoId) throw new Error('set -e VIDEO_ID=<uuid of a READY video>');
  const url = `${api}/api/videos/${videoId}/playback${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const res = http.get(url, {
    tags: { name: 'GET /api/videos/:id/playback' },
    responseCallback: http.expectedStatuses(200, 429),
  });
  check(res, {
    'playback served or refused cleanly': (r) => r.status === 200 || r.status === 429,
    'answer is small': (r) => r.body.length < 4096,
    'a public answer sets no cookie': (r) => token || !r.headers['Set-Cookie'],
  });
}
