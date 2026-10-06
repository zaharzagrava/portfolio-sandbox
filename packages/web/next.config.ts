import type { NextConfig } from "next";

// Local backend ports (packages/backend start:dev:* scripts). Next itself runs on 3000, so never default to it.
const API_URL = process.env.API_URL ?? "http://localhost:8000";
// Locally `moon run :dev-monolith` serves core, BFF and SSE on one port; running the apps separately
// (dev-api / dev-bff / dev-sse) sets BFF_URL=http://localhost:8006 and SSE_URL=http://localhost:8001.
const BFF_URL = process.env.BFF_URL ?? API_URL;
const SSE_URL = process.env.SSE_URL ?? API_URL;

const nextConfig: NextConfig = {
  // Enable experimental Partial Prerendering for static shell + dynamic holes
  cacheComponents: true,
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3100", "marketplace.localhost"],
    },
  },

  // Allow images from MinIO/S3 and placeholder services
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9100" }, // MinIO
      { protocol: "https", hostname: "*.amazonaws.com" },       // S3
      { protocol: "https", hostname: "images.unsplash.com" },   // Placeholders
    ],
  },

  // Proxy API routes to backend services (avoids CORS in development)
  // Same routing as the production ALB (infra/stack): specific services first, core catches the rest.
  // Rewrites are matched in order, so the generic /api/:path* rule must stay last.
  async rewrites() {
    return [
      // GraphQL + REST aggregates → BFF
      { source: "/api/graphql", destination: `${BFF_URL}/api/graphql` },
      { source: "/api/bff/:path*", destination: `${BFF_URL}/api/bff/:path*` },
      // Long-lived streams → SSE gateway
      { source: "/api/streams", destination: `${SSE_URL}/api/streams` },
      { source: "/api/live/:id/events", destination: `${SSE_URL}/api/live/:id/events` },
      { source: "/api/payment/stream", destination: `${SSE_URL}/api/payment/stream` },
      { source: "/api/assistant/:path*", destination: `${SSE_URL}/api/assistant/:path*` },
      // Everything else → core
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
    ];
  },

  // /admin has no page of its own (a page calling redirect() can't be prerendered).
  async redirects() {
    return [{ source: "/admin", destination: "/admin/feature-flags", permanent: false }];
  },

  // Security headers
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
