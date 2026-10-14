'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { identify as identifyApi, type IdentifyResult } from '@/lib/api/widget';
import { acceptIdentityMessage, isWebOrigin, MESSAGE_TYPES, postToHost } from '@/lib/widget/messages';

const FAILURE_TEXT = "We couldn't open checkout. Close this window and try again.";
/** The loader answers within 5 s (null when the host has no hook); a little longer than that means nobody will answer. */
const DEFAULT_IDENTITY_WAIT_MS = 7000;

type Phase = { name: 'checking' } | { name: 'signed-in'; email: string | null } | { name: 'guest' } | { name: 'failed' };

// Inline style objects are set through the CSSOM, which the embed document's policy (no `style-src`) does not block.
const box: CSSProperties = { display: 'flex', minHeight: '100vh', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, fontFamily: 'system-ui, sans-serif', textAlign: 'center' };
const closeButton: CSSProperties = { minHeight: 44, minWidth: 44, padding: '8px 20px', fontSize: 16, cursor: 'pointer', borderRadius: 6, border: '1px solid currentColor', background: 'transparent', color: 'inherit' };

export type CheckoutAppProps = {
  /** The site's publishable key (`data-site` of the embed document). */
  siteKey: string;
  /** The host page's origin, or `null` when the browser cannot say (then nothing is posted and checkout does not open). */
  hostOrigin: string | null;
  parent: Window | null;
  identify?: (key: string, token: string) => Promise<IdentifyResult>;
  identityTimeoutMs?: number;
};

/**
 * The iframe half of the widget (W07 AS-40): asks the host page who the customer is, exchanges the hand-off token through
 * S44 `identify`, shows the outcome, and tells the host page to close. The screens after identification are not part of
 * this release.
 */
export function CheckoutApp({ siteKey, hostOrigin, parent, identify = identifyApi, identityTimeoutMs = DEFAULT_IDENTITY_WAIT_MS }: CheckoutAppProps) {
  // Without a window to talk to and a host origin to address it, checkout cannot open: decided up front, not in an effect.
  const [phase, setPhase] = useState<Phase>(() => (isWebOrigin(hostOrigin) && parent ? { name: 'checking' } : { name: 'failed' }));
  const asked = useRef(false);
  const settled = useRef(false);

  const close = useCallback(() => {
    if (parent) postToHost(parent, hostOrigin, { type: MESSAGE_TYPES.close });
  }, [parent, hostOrigin]);

  // Ask once for the identity (development mounts effects twice).
  useEffect(() => {
    if (asked.current || !parent || !isWebOrigin(hostOrigin)) return;
    asked.current = true;
    postToHost(parent, hostOrigin, { type: MESSAGE_TYPES.needIdentity });
  }, [parent, hostOrigin]);

  // The answer: only from the parent window and the host origin; the first valid one wins.
  useEffect(() => {
    if (!parent || !hostOrigin) return;
    let cancelled = false;
    function onMessage(event: MessageEvent) {
      if (settled.current) return;
      const accepted = acceptIdentityMessage({ source: event.source, origin: event.origin, data: event.data }, { parent, hostOrigin });
      if (!accepted) return;
      settled.current = true;
      if (accepted.token === null) {
        setPhase({ name: 'guest' });
        return;
      }
      void identify(siteKey, accepted.token).then((result) => {
        if (cancelled) return;
        setPhase(result.ok ? { name: 'signed-in', email: result.customer.email } : { name: 'failed' });
      });
    }
    window.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => {
      if (settled.current) return;
      settled.current = true;
      setPhase({ name: 'guest' });
    }, identityTimeoutMs);
    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };
  }, [parent, hostOrigin, siteKey, identify, identityTimeoutMs]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <main style={box}>
      {phase.name === 'checking' && (
        <p role="status" aria-busy="true">
          Checking your details…
        </p>
      )}
      {phase.name === 'signed-in' && <p role="status">{phase.email ? `Signed in as ${phase.email}` : 'Signed in'}</p>}
      {phase.name === 'guest' && <p role="status">Continue as guest</p>}
      {phase.name === 'failed' && <p role="alert">{FAILURE_TEXT}</p>}
      <button type="button" style={closeButton} onClick={close}>
        Close
      </button>
    </main>
  );
}
