This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment (storefront)

See `.env.example`. The values below are read once by `lib/config-parse.ts`; a bad value fails the first request naming the variable.

| Variable | Meaning |
|---|---|
| `API_URL`, `BFF_URL`, `SITE_URL` | Server-only. `SITE_URL` is required in production and must be `https`; it is the origin of share links and canonical addresses. |
| `MEDIA_HOST` | Exact origin(s) of the media delivery host. The only image host `next/image` and the CSP accept. |
| `VIDEO_HOST` | Exact origin(s) of the video delivery host (CSP `media-src`). None by default. |
| `MAP_TILE_HOST` | Exact origin of the map tile server (CSP). |
| `NEXT_PUBLIC_MAP_TILE_URL` | Public tile template with `{z}/{x}/{y}`; its origin must equal `MAP_TILE_HOST`. Unset: the pickup map shows the list view only. |
| `STOREFRONT_ADS_ENABLED` | `true` turns on the sponsored slot on `/search`. Off by default. |
| `PAYMENT_PROVIDER_HOSTS` | Server-only. Exact https origin(s) of the payment provider (scripts, frames, API). The CSP adds them on `/checkout/pay/*` only; no other page may load them. |
| `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY` | Public. The provider's publishable key for the hosted card fields (loaded lazily on the pay page). |
| `NEXT_PUBLIC_PAYMENTS_SANDBOX` | Public. `true` shows the sandbox card picker instead of the provider's fields. Ignored when `NODE_ENV` is `production`. |

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
