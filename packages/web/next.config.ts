import type { NextConfig } from "next";
import { parseConfig } from "./lib/config-parse";
import { securityHeaderRules } from "./lib/security/headers";

// One parsed configuration for the whole app (lib/config-parse.ts): service addresses, exact media hosts, allowed origins.
// A bad value fails here, at start and at build, naming the variable.
const config = parseConfig(process.env);

const nextConfig: NextConfig = {
  // Separate output directory for the production build that the security-headers Playwright spec runs next to `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // Caches data (`"use cache"`). It also prerenders a static shell, whose scripts cannot carry the per-response nonce of
  // the CSP (Next.js CSP guide: PPR is incompatible with a nonce policy), so the root layout opts out of the static shell
  // (`instant = false` + reading the nonce from the request): every document is rendered per request.
  cacheComponents: true,
  poweredByHeader: false,
  // The contracts workspace ships TypeScript source (explicit .ts import extensions).
  transpilePackages: ["@marketplace-sandbox/contracts"],
  experimental: {
    serverActions: {
      allowedOrigins: config.allowedOrigins,
    },
  },

  // Images only from the exact hosts that `img-src` allows (same list, lib/config-parse.ts).
  images: {
    remotePatterns: config.mediaHosts.map((host) => {
      const url = new URL(host);
      return {
        protocol: url.protocol.slice(0, -1) as "http" | "https",
        hostname: url.hostname,
        ...(url.port ? { port: url.port } : {}),
      };
    }),
  },

  // Proxy API routes to backend services (avoids CORS in development)
  // Same routing as the production ALB (infra/stack): specific services first, core catches the rest.
  // Rewrites are matched in order, so the generic /api/:path* rule must stay last.
  async rewrites() {
    return [
      // GraphQL + REST aggregates → BFF
      { source: "/api/graphql", destination: `${config.bffUrl}/api/graphql` },
      { source: "/api/bff/:path*", destination: `${config.bffUrl}/api/bff/:path*` },
      // Everything else goes through the BFF forwarder (W01 C-FWD): it turns the session cookie into the bearer token on
      // the server and routes long-lived streams (/api/streams, /api/live/:id/events, /api/payment/stream,
      // /api/assistant/*) to the SSE gateway and the rest to the core API. The browser never holds a token.
      { source: "/api/:path*", destination: `${config.bffUrl}/api/bff/f/:path*` },
    ];
  },

  // /admin has no page of its own (a page calling redirect() can't be prerendered).
  // /account has no page of its own either: security settings are its first screen (W01).
  async redirects() {
    return [
      { source: "/admin", destination: "/admin/feature-flags", permanent: false },
      { source: "/account", destination: "/account/security", permanent: false },
      // The link inside notifications (S28 catalog) points at /settings/notifications; the screen lives under /account.
      { source: "/settings/notifications", destination: "/account/notifications", permanent: false },
      // The old second-step route (it carried the challenge in the URL) is gone; the pending sign-in lives in a cookie now.
      { source: "/mfa", destination: "/login", permanent: false },
    ];
  },

  // Static security headers and per-path rules (lib/security/headers.ts). The CSP is per request: proxy.ts.
  async headers() {
    return securityHeaderRules(process.env.NODE_ENV === "production");
  },
};

export default nextConfig;
