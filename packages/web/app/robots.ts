import type { MetadataRoute } from 'next';
import { config } from '@/lib/config';
import { noStorePaths } from '@/lib/security/headers';

/**
 * `/robots.txt` (W07 AS-34, FR-052): public pages allowed; the disallow list is the no-store list of the security headers,
 * so the two cannot diverge. There is no sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...noStorePaths] }],
    host: config.siteUrl,
  };
}
