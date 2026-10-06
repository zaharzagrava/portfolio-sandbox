'use client';

import { safeReturnUrl } from '@/lib/safe-return-url';
import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';

export function MfaForm() {
  const { verifyMfa: completeMfa } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));
  
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [isLoading, setIsLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!token) {
      toast.error('Invalid session. Please log in again.');
      router.push('/login');
    }
  }, [token, router]);

  const verifyMfa = async (mfaCode: string) => {
    setIsLoading(true);
    try {
      await completeMfa(token, mfaCode);
      toast.success('Verification successful!');
      router.push(returnUrl);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Invalid code. Please try again.');
      setCode(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (index: number, value: string) => {
    if (!/^[0-9]*$/.test(value)) return;
    
    const newCode = [...code];
    newCode[index] = value.substring(value.length - 1);
    setCode(newCode);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto submit if all 6 digits are filled
    const fullCode = newCode.join('');
    if (fullCode.length === 6) {
      verifyMfa(fullCode);
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').slice(0, 6).split('');
    if (pastedData.some(char => !/^[0-9]$/.test(char))) return;

    const newCode = [...code];
    pastedData.forEach((char, index) => {
      if (index < 6) newCode[index] = char;
    });
    setCode(newCode);

    const nextEmptyIndex = newCode.findIndex(val => val === '');
    const focusIndex = nextEmptyIndex === -1 ? 5 : nextEmptyIndex;
    inputRefs.current[focusIndex]?.focus();

    if (newCode.join('').length === 6) {
      verifyMfa(newCode.join(''));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.join('').length === 6) {
      verifyMfa(code.join(''));
    }
  };

  return (
    <Card className="border-none shadow-none sm:border-solid sm:shadow-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl font-semibold tracking-tight">Two-Step Verification</CardTitle>
        <CardDescription>
          Enter the 6-digit code from your authenticator app
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6">
          <div className="flex justify-center gap-2 sm:gap-3">
            {code.map((digit, index) => (
              <Input
                key={index}
                ref={(el) => { inputRefs.current[index] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={1}
                value={digit}
                onChange={(e) => handleChange(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
                onPaste={handlePaste}
                disabled={isLoading}
                className="w-10 h-12 sm:w-12 sm:h-14 text-center text-lg sm:text-xl font-bold transition-all duration-200 focus-visible:ring-indigo-500"
              />
            ))}
          </div>
          <Button type="submit" className="w-full transition-all bg-indigo-600 hover:bg-indigo-700 text-white" disabled={isLoading || code.join('').length !== 6}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Verify
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col items-center">
        <Button variant="link" className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">
          Use recovery code instead
        </Button>
      </CardFooter>
    </Card>
  );
}
