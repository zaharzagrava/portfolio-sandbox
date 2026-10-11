import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';

/**
 * Shell of the auth pages (W01 FR-050). A Server Component that reads nothing from the request. The site `<main>` comes
 * from the root layout, so this renders plain containers: at >= 1024 px two columns (decorative brand panel + form
 * column), below that one centred column with the logo link above the card. The panel is `aria-hidden` and has no
 * heading and nothing focusable; each page supplies the single `h1`.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-[70vh] bg-background lg:grid-cols-2">
      <div aria-hidden="true" className="relative hidden bg-zinc-900 lg:block">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 via-purple-500/20 to-zinc-900/50" />
        <div className="absolute inset-0 flex flex-col justify-between p-12 text-zinc-100">
          <div className="flex items-center gap-2 text-2xl font-bold">
            <ShoppingBag className="h-6 w-6 text-indigo-400" />
            <span>Marketplace</span>
          </div>
          <div className="space-y-4">
            <p className="text-4xl font-bold tracking-tight text-white">Discover unique products from independent creators.</p>
            <p className="max-w-md text-zinc-400">
              Join our community of buyers and sellers today. Experience a secure, seamless marketplace designed for modern commerce.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-center px-4 py-10 sm:px-6 lg:px-12">
        <div className="mx-auto w-full max-w-md lg:max-w-[28rem]">
          <div className="mb-8 flex justify-center lg:hidden">
            <Link href="/" className="flex min-h-11 items-center gap-2 text-2xl font-bold">
              <ShoppingBag className="h-6 w-6 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
              <span>Marketplace</span>
            </Link>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
