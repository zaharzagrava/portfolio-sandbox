/**
 * Hybrid Logical Clock (06/02 §6): wall-clock-ish timestamps that never go
 * backwards and order causally related events correctly even when device
 * clocks are skewed. Encoded so plain string comparison = HLC order:
 *   "<physical ms, 15 digits>-<logical counter, 5 digits>-<node id>"
 * The node id breaks ties deterministically (two devices, same ms, same counter).
 */
export interface Hlc {
  physical: number;
  logical: number;
  node: string;
}

export const encodeHlc = ({ physical, logical, node }: Hlc) => `${String(physical).padStart(15, '0')}-${String(logical).padStart(5, '0')}-${node}`;

export function decodeHlc(value: string): Hlc | null {
  const m = /^(\d{15})-(\d{5})-([\w-]{1,64})$/.exec(value);
  return m ? { physical: Number(m[1]), logical: Number(m[2]), node: m[3] } : null;
}

/** Local event / send. */
export function tick(local: Hlc, now: number): Hlc {
  return now > local.physical ? { physical: now, logical: 0, node: local.node } : { ...local, logical: local.logical + 1 };
}

/** Receive a remote timestamp: the result is after both, so causality is preserved. */
export function receive(local: Hlc, remote: Hlc, now: number): Hlc {
  const physical = Math.max(local.physical, remote.physical, now);
  let logical = 0;
  if (physical === local.physical && physical === remote.physical) logical = Math.max(local.logical, remote.logical) + 1;
  else if (physical === local.physical) logical = local.logical + 1;
  else if (physical === remote.physical) logical = remote.logical + 1;
  return { physical, logical, node: local.node };
}

/** A device clock far in the future would win every LWW race forever - cap the drift we accept. */
export const MAX_DRIFT_MS = 60_000;
export function plausible(hlc: Hlc, now: number): boolean {
  return hlc.physical <= now + MAX_DRIFT_MS;
}
