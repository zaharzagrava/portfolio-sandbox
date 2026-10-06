import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t bg-background">
      <div className="container mx-auto flex flex-col items-center justify-between gap-4 py-10 md:h-24 md:flex-row md:py-0 px-4 md:px-6">
        <div className="flex flex-col items-center gap-4 md:flex-row md:gap-2">
          <p className="text-center text-sm leading-loose text-muted-foreground md:text-left">
            Built by Showcase. The source code is available on GitHub.
          </p>
        </div>
        <div className="flex items-center space-x-4">
          <Link
            href="/terms"
            className="text-sm font-medium text-muted-foreground hover:underline underline-offset-4"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="text-sm font-medium text-muted-foreground hover:underline underline-offset-4"
          >
            Privacy
          </Link>
        </div>
      </div>
    </footer>
  );
}
