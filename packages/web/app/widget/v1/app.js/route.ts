import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The widget checkout application (W07 AS-39, S44 `widget_app_bundle_url`): the script that S44's embed document loads
 * from another origin. The only response of the web app meant to be loaded cross-origin, hence `Cross-Origin-Resource-Policy:
 * cross-origin`. Built by `pnpm build:widget` into `.widget/app.js`; kept out of the proxy matcher (no document policy).
 */
const BUNDLE = path.join(process.cwd(), '.widget', 'app.js');

export async function GET(): Promise<Response> {
  let script: Buffer;
  try {
    script = await readFile(BUNDLE);
  } catch {
    return new Response('The checkout application is not available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(new Uint8Array(script), {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
