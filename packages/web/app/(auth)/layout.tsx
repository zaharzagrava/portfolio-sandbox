import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Left Decorative Side */}
      <div className="hidden w-1/2 lg:block relative bg-zinc-900">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 via-purple-500/20 to-zinc-900/50" />
        <div className="absolute inset-0 bg-[url('/noise.png')] opacity-10 mix-blend-overlay" />
        <div className="absolute inset-0 flex flex-col justify-between p-12 text-zinc-100">
          <Link href="/" className="flex items-center gap-2 font-bold text-2xl transition-opacity hover:opacity-80">
            <ShoppingBag className="h-6 w-6 text-indigo-400" />
            <span>Marketplace</span>
          </Link>
          <div className="space-y-4">
            <h1 className="text-4xl font-bold tracking-tight text-white">
              Discover unique products from independent creators.
            </h1>
            <p className="text-zinc-400 max-w-md">
              Join our community of buyers and sellers today. Experience a secure, seamless marketplace designed for modern commerce.
            </p>
          </div>
        </div>
      </div>
      
      {/* Right Form Side */}
      <div className="flex w-full flex-col justify-center px-4 py-12 sm:px-6 lg:w-1/2 lg:px-20 xl:px-24 relative">
        <div className="mx-auto w-full max-w-sm lg:max-w-md">
          {/* Mobile Logo */}
          <div className="flex justify-center mb-8 lg:hidden">
            <Link href="/" className="flex items-center gap-2 font-bold text-2xl">
              <ShoppingBag className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
              <span>Marketplace</span>
            </Link>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
