import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Suspense } from 'react';
import { PageView } from '@/components/analytics/page-view';
import { SessionBootstrap } from '@/components/auth/session-bootstrap';
import { Footer } from '@/components/layout/footer';
import { Navbar } from '@/components/layout/navbar';
import { NonceProviders } from '@/components/layout/nonce-providers';
import { RouteFocus } from '@/components/layout/route-focus';
import { SkipLink } from '@/components/layout/skip-link';
import { siteUrl } from '@/lib/server/endpoints.server';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'Marketplace', template: '%s · Marketplace' },
  description: 'A modern full-stack marketplace platform built with Next.js 16',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// No static shell for any route: the nonce of the CSP is per response, so a prerendered shell could not carry it
// (docs: `instant = false` on the root layout disables static-shell validation for the whole app).
export const instant = false;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen flex flex-col`}
      >
        {/* The nonce comes from the request, so every document renders per request (never a prerendered shell). */}
        <NonceProviders>
          {/* The session is read on the server only inside this boundary, never at the top of the layout (W01 FR-005). */}
          <Suspense fallback={null}>
            <SessionBootstrap />
          </Suspense>
          <SkipLink />
          <Navbar />
          <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </main>
          <Footer />
          <RouteFocus />
          <Suspense fallback={null}>
            <PageView />
          </Suspense>
        </NonceProviders>
      </body>
    </html>
  );
}
