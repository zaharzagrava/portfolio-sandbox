import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/lib/providers';
import { AuthProvider } from '@/hooks/use-auth';
import { Navbar } from '@/components/layout/navbar';
import { Footer } from '@/components/layout/footer';
import { AssistantSheet } from '@/components/assistant/assistant-sheet';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Marketplace Showcase',
  description: 'A modern full-stack marketplace platform built with Next.js 16',
};

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
        <Providers>
          <AuthProvider>
            <Navbar />
            <main className="flex-1">{children}</main>
            <Footer />
            <AssistantSheet />
          </AuthProvider>
        </Providers>
      </body>
    </html>
  );
}
