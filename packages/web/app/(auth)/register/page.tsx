'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api/errors';

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters.'),
  email: z.string().email('Please enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  confirmPassword: z.string(),
  terms: z.boolean().refine(val => val === true, {
    message: 'You must accept the terms and conditions.'
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [isLoading, setIsLoading] = useState(false);

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      terms: false,
    },
  });

  async function onSubmit(data: RegisterFormValues) {
    setIsLoading(true);
    try {
      // Registration signs the user in (the backend returns a session), so go straight home.
      await register({ email: data.email, password: data.password });
      toast.success('Registration successful!');
      router.push('/');
    } catch (error: any) {
      toast.error(apiErrorMessage(error, 'Failed to register. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="border-none shadow-none sm:border-solid sm:shadow-sm">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-semibold tracking-tight">Create an account</CardTitle>
        <CardDescription>
          Enter your details below to create your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              placeholder="John Doe"
              className="transition-all duration-200 focus-visible:ring-indigo-500"
              disabled={isLoading}
              {...form.register('name')}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="m@example.com"
              className="transition-all duration-200 focus-visible:ring-indigo-500"
              disabled={isLoading}
              {...form.register('email')}
            />
            {form.formState.errors.email && (
              <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              className="transition-all duration-200 focus-visible:ring-indigo-500"
              disabled={isLoading}
              {...form.register('password')}
            />
            {form.formState.errors.password && (
              <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <Input
              id="confirmPassword"
              type="password"
              className="transition-all duration-200 focus-visible:ring-indigo-500"
              disabled={isLoading}
              {...form.register('confirmPassword')}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-destructive">{form.formState.errors.confirmPassword.message}</p>
            )}
          </div>
          <div className="flex items-center space-x-2 pt-2">
            <Checkbox 
              id="terms" 
              disabled={isLoading}
              onCheckedChange={(checked) => form.setValue('terms', checked as true, { shouldValidate: true })}
            />
            <Label
              htmlFor="terms"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              I agree to the terms and conditions
            </Label>
          </div>
          {form.formState.errors.terms && (
            <p className="text-sm text-destructive">{form.formState.errors.terms.message}</p>
          )}
          <Button type="submit" className="w-full mt-4 transition-all bg-indigo-600 hover:bg-indigo-700 text-white" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create account
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col items-center">
        <div className="text-sm text-center text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
            Log in
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}
