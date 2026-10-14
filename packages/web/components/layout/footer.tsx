import Link from 'next/link';
import { config } from '@/lib/config';

const link = 'inline-flex min-h-11 min-w-11 items-center text-sm font-medium text-muted-foreground underline-offset-4 hover:underline lg:min-h-0 lg:min-w-0';

export function Footer() {
  const year = new Date().getFullYear();
  // `config.sourceCodeUrl` is set only for an `https:` address (lib/config-parse.ts).
  const sourceCodeUrl = config.sourceCodeUrl;

  return (
    <footer className="border-t bg-background">
      <div className="container mx-auto flex flex-col gap-4 px-4 py-8 md:px-6 lg:flex-row lg:items-center lg:justify-between lg:py-6">
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-loose text-muted-foreground">
            Marketplace is a portfolio project: no real goods are sold and no real payments are taken.
          </p>
          <p className="text-sm text-muted-foreground">© {year} Marketplace</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-col gap-1 lg:flex-row lg:gap-6">
            <li>
              <Link href="/search" className={link}>
                Browse
              </Link>
            </li>
            <li>
              <Link href="/developers/docs" className={link}>
                API docs
              </Link>
            </li>
            <li>
              <Link href="/terms" className={link}>
                Terms
              </Link>
            </li>
            <li>
              <Link href="/privacy" className={link}>
                Privacy
              </Link>
            </li>
            {sourceCodeUrl && (
              <li>
                <a href={sourceCodeUrl} target="_blank" rel="noopener noreferrer" className={link}>
                  Source code{' '}
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            )}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
