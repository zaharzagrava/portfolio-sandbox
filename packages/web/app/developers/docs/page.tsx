'use client';

import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm font-medium transition-colors">
              <ArrowLeft className="h-4 w-4" />
              Back to Marketplace
            </Link>
            <div className="h-4 w-px bg-border" />
            <h1 className="text-lg font-semibold tracking-tight">API Documentation</h1>
          </div>
          <div className="text-sm text-muted-foreground">
            Marketplace Developers
          </div>
        </div>
      </header>

      <main className="flex-1 bg-white">
        {/* Swagger UI handles its own layout and scrolling inside */}
        <div className="container mx-auto py-8">
          <SwaggerUI url="http://localhost:3000/docs-json" />
        </div>
      </main>
    </div>
  );
}
