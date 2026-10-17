'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ProblemPanel, RateLimitNotice } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/api/errors';
import { roleLabel, SELLER_HOME } from '@/lib/seller/nav';
import type { AcceptInviteResult } from '@/lib/server/invite.server';

const STATUS: Record<string, number> = { invite_not_found: 404, rate_limited: 429, unauthenticated: 401, service_unavailable: 503 };

/**
 * The accept button of `/invites/{token}` (W04 AS-80, AS-81). Nothing happens until the explicit press, and then once: the
 * action carries the token (bound on the server), so this component never sees it. Success replaces the history entry with
 * the shop, so the invitation address is not one back-press away; every refusal reads the same.
 */
export function AcceptInvite({ accept }: { accept: () => Promise<AcceptInviteResult> }) {
  const router = useRouter();
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);

  async function press() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setProblem(null);
    let result: AcceptInviteResult;
    try {
      result = await accept();
    } catch {
      result = { ok: false, code: 'service_unavailable' };
    }
    if (result.ok) {
      toast.success(result.alreadyMember ? "You're already a member." : `You joined as ${roleLabel(result.role)}.`);
      router.replace(`/dashboard/seller/${encodeURIComponent(result.shopId)}`);
      return;
    }
    setAttempt((count) => count + 1);
    setProblem({ status: STATUS[result.code] ?? 503, code: result.code, errors: [], ...(result.retryAfter ? { retryAfterSeconds: result.retryAfter } : {}) });
    running.current = false;
    setPending(false);
  }

  const refused = problem?.code === 'invite_not_found';
  return (
    <section className="space-y-4 rounded-lg border p-6">
      <h1 className="text-xl font-bold tracking-tight">You&apos;ve been invited to join a shop.</h1>
      <p className="text-sm text-muted-foreground">Accept to get access with the role the invitation gives you.</p>
      {problem &&
        (problem.code === 'rate_limited' ? (
          <RateLimitNotice seconds={problem.retryAfterSeconds} token={attempt} onActiveChange={setWaiting} />
        ) : (
          <ProblemPanel problem={problem} context={{ place: 'page' }} />
        ))}
      {refused ? (
        <Button asChild className="min-h-11 sm:min-h-8">
          <Link href={SELLER_HOME}>Go to your dashboard</Link>
        </Button>
      ) : (
        <Button type="button" className="min-h-11 sm:min-h-8" disabled={pending || waiting} aria-busy={pending} onClick={() => void press()}>
          Accept invitation
        </Button>
      )}
    </section>
  );
}
