'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api/client';

const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address.'),
});

type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

export default function ForgotPasswordPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const form = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: '',
    },
  });

  async function onSubmit(data: ForgotPasswordFormValues) {
    setIsLoading(true);
    try {
      // POST to /api/auth/forgot-password
      await apiClient.post('/api/auth/forgot-password', data);
    } catch (error) {
      // We ignore errors to prevent username enumeration
      console.error(error);
    } finally {
      // Always show success state regardless of actual response
      setIsLoading(false);
      setIsSubmitted(true);
    }
  }

  if (isSubmitted) {
    return (
      <Card className="border-none shadow-none sm:border-solid sm:shadow-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-semibold tracking-tight">Check your email</CardTitle>
          <CardDescription>
            If an account exists for that email, we've sent a password reset link.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <div className="rounded-full bg-indigo-100 p-3 dark:bg-indigo-900/30">
            <svg
              className="h-10 w-10 text-indigo-600 dark:text-indigo-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-center">
          <Link href="/login" className="flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to login
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="border-none shadow-none sm:border-solid sm:shadow-sm">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-semibold tracking-tight">Forgot password</CardTitle>
        <CardDescription>
          Enter your email address and we'll send you a link to reset your password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="m@example.com"
              className="transition-all duration-200 focus-visible:ring-indigo-500"
              autoComplete="email"
              autoFocus
              disabled={isLoading}
              {...form.register('email')}
            />
            {form.formState.errors.email && (
              <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <Button type="submit" className="w-full mt-2 transition-all bg-indigo-600 hover:bg-indigo-700 text-white" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send reset link
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col items-center">
        <Link href="/login" className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to login
        </Link>
      </CardFooter>
    </Card>
  );
}
