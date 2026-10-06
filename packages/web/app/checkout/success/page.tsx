import Link from 'next/link';
import { Suspense } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

type Props = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** Only the order number depends on the URL: it streams in, the rest of the page is prerendered. */
async function OrderNumber({ searchParams }: Props) {
  const resolvedParams = await searchParams;
  return <>{typeof resolvedParams.orderId === 'string' ? resolvedParams.orderId : 'UNKNOWN'}</>;
}

export default function CheckoutSuccessPage({ searchParams }: Props) {
  return (
    <div className="container mx-auto py-20 px-4 md:px-6 flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md w-full text-center border-none shadow-none md:border-solid md:shadow-sm">
        <CardHeader>
          <div className="flex justify-center mb-4">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
          </div>
          <CardTitle className="text-3xl font-bold">Order Confirmed!</CardTitle>
          <CardDescription className="text-lg mt-2">
            Thank you for your purchase.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            We have received your order and are currently processing it. You will receive an email confirmation shortly.
          </p>
          <div className="bg-muted p-4 rounded-md mt-6">
            <p className="text-sm font-medium">Order Number</p>
            <p className="text-lg font-bold text-primary">
              <Suspense fallback="…">
                <OrderNumber searchParams={searchParams} />
              </Suspense>
            </p>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row gap-4 justify-center mt-8">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/">Return to Home</Link>
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link href="/dashboard/orders">View Orders</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
