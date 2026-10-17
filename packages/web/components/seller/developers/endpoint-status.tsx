import type { WebhookEndpointDto } from '@marketplace-sandbox/contracts';
import { Badge } from '@/components/ui/badge';
import { Instant } from './shared';

/**
 * The health of an endpoint in words (W04 AS-56): enabled or disabled with the reason, the breaker when it is open, and the
 * overlap of a previous signing secret. A notice is text, not colour only.
 */
export function EndpointStatus({ endpoint }: { endpoint: WebhookEndpointDto }) {
  const disabled = endpoint.status === 'disabled';
  return (
    <span className="flex flex-col items-start gap-1">
      {disabled ? (
        endpoint.disabledReason === 'auto_failing' ? (
          <Badge variant="destructive" className="h-auto whitespace-normal">
            Disabled automatically after repeated failures (since <Instant value={endpoint.failingSince} />)
          </Badge>
        ) : (
          <Badge variant="outline">Disabled (paused by you)</Badge>
        )
      ) : (
        <Badge variant="secondary">Enabled</Badge>
      )}
      {endpoint.breaker === 'open' && !disabled && <span className="text-xs text-amber-800 dark:text-amber-200">Retrying after failures</span>}
      {endpoint.hasPreviousSecret && endpoint.previousSecretExpiresAt && (
        <span className="text-xs text-muted-foreground">
          Old secret valid until <Instant value={endpoint.previousSecretExpiresAt} />
        </span>
      )}
    </span>
  );
}
