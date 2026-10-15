import {
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { CatalogSyncError, syncProblem } from '../domain/catalog-sync-errors';
import { parseCredentials } from '../domain/credentials';
import { transition as nextStatus } from '../domain/integration-status';
import { checkTimestamp } from '../domain/webhook-verify';
import {
  CREDENTIAL_VAULT,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  PROVIDER_SESSIONS,
  RECEIPT_REPOSITORY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type CredentialVault,
  type IntegrationRecord,
  type IntegrationRepository,
  type ParsedWebhook,
  type ProviderSessions,
  type ReceiptRepository,
  type SyncMessage,
  type SyncQueue,
  type WebhookHeaders,
} from '../domain/ports';
import { IntegrationStatusChanged } from './events/integration-events';
import { webhooksCounter } from './sync-metrics';

/** A webhook body above this is refused (`413`) before anything is looked at (AS-32). */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

type WebhookResult = 'accepted' | 'duplicate' | 'ignored';

/** The metric result of a refused delivery: a closed set, never the error text. */
function refusal(
  error: unknown,
): 'too_large' | 'stale' | 'invalid_signature' | 'unavailable' {
  if (error instanceof PayloadTooLargeException) return 'too_large';
  if (error instanceof ServiceUnavailableException) return 'unavailable';
  if (error instanceof CatalogSyncError && error.syncCode === 'webhook_stale')
    return 'stale';
  return 'invalid_signature';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The webhook fast path (FR-030 - FR-033, AS-26 - AS-34). Anything that fails authentication - an unknown, malformed or
 * disconnected integration, a missing or wrong signature, a body that is not understood - is the same `401`
 * `invalid_webhook_signature`, so existence is not revealed. The signature is checked over the exact received bytes
 * (`rawBody`), never over a re-serialised body (A20). A webhook is only a hint: it is acknowledged first and a thin
 * `one` message makes the worker fetch the current state; nothing in the payload is applied.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(RECEIPT_REPOSITORY) private readonly receipts: ReceiptRepository,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  /** Resolves when the delivery is acknowledged (`200`); throws the problem for every refusal. */
  async accept(
    integrationId: string,
    headers: WebhookHeaders,
    rawBody: Buffer | undefined,
  ): Promise<void> {
    const seen = { provider: 'unknown' };
    let result: WebhookResult;
    try {
      result = await this.process(integrationId, headers, rawBody, seen);
    } catch (error) {
      webhooksCounter.add(1, {
        provider: seen.provider,
        result: refusal(error),
      });
      throw error;
    }
    webhooksCounter.add(1, { provider: seen.provider, result });
  }

  private async process(
    integrationId: string,
    headers: WebhookHeaders,
    rawBody: Buffer | undefined,
    seen: { provider: string },
  ): Promise<WebhookResult> {
    if (!UUID.test(integrationId))
      throw syncProblem('invalid_webhook_signature');
    const integration = await this.integrations.findById(
      integrationId.toLowerCase(),
    );
    if (!integration || integration.status === 'DISCONNECTED')
      throw syncProblem('invalid_webhook_signature');
    seen.provider = integration.provider;
    if (!rawBody) throw syncProblem('invalid_webhook_signature');
    if (rawBody.length > MAX_WEBHOOK_BYTES)
      throw new PayloadTooLargeException();

    const provider = this.sessions.provider(integration.provider);
    if (
      !provider.verifyWebhook(headers, rawBody, this.webhookSecret(integration))
    )
      throw syncProblem('invalid_webhook_signature');
    const parsed = provider.parseWebhook(headers, rawBody);
    if (!parsed) throw syncProblem('invalid_webhook_signature');

    const now = this.clock.now();
    const age = checkTimestamp(parsed.triggeredAt, now);
    if (age === 'stale') throw syncProblem('webhook_stale');
    if (age === 'invalid') throw syncProblem('invalid_webhook_signature');

    // Paused and re-authorisation integrations acknowledge and do nothing: the resume catch-up converges (AS-34).
    if (integration.status !== 'ACTIVE') return 'ignored';

    const work = this.workFor(integration, parsed);
    if (!work) return 'ignored'; // ping, an unhandled topic, or an id that cannot be queued

    if (
      !(await this.receipts.insertIfNew(integration.id, parsed.deliveryId, now))
    )
      return 'duplicate'; // AS-28
    try {
      await work(now);
    } catch (error) {
      // Our own receipt goes, so the provider's retry is processed, not mistaken for a duplicate (AS-31).
      await this.receipts
        .remove(integration.id, parsed.deliveryId)
        .catch(() => undefined);
      this.logger.error({
        action: 'catalog-sync.webhook_not_accepted',
        integrationId: integration.id,
        shopId: integration.shopId,
        topic: parsed.topic,
        error: (error as Error)?.name,
      });
      throw new ServiceUnavailableException();
    }
    return 'accepted';
  }

  /** What to do for a verified delivery, or `null` when there is nothing to do. */
  private workFor(
    integration: IntegrationRecord,
    parsed: ParsedWebhook,
  ): ((now: Date) => Promise<void>) | null {
    const enqueue = (message: SyncMessage) => () =>
      this.queue.enqueue(INTEGRATION_SYNC_QUEUE, message);
    switch (parsed.topic) {
      case 'product_changed':
      case 'product_deleted':
        // The product's current state is read at the provider; a delete is confirmed by that read (AS-30).
        if (!parsed.externalId || parsed.externalId.length > 64) return null;
        return enqueue({
          integrationId: integration.id,
          kind: 'one',
          externalId: parsed.externalId,
        });
      case 'inventory_changed':
        // The payload names an inventory item, not a product: the next incremental pass reads the stock (hint only).
        return enqueue({ integrationId: integration.id, kind: 'incremental' });
      case 'app_uninstalled':
        return (now) => this.disconnect(integration, now);
      case 'ping':
      case 'ignored':
        return null;
    }
  }

  /** The store uninstalled the app: `DISCONNECTED`, credentials erased, links kept, one status event (AS-30). */
  private async disconnect(
    integration: IntegrationRecord,
    now: Date,
  ): Promise<void> {
    const decision = nextStatus(integration.status, 'disconnect');
    if (decision.kind !== 'moved') return;
    await this.transactions.run(async () => {
      const moved = await this.integrations.transition(
        integration.id,
        integration.status,
        decision.to,
        {
          reason: 'uninstalled',
          actorId: null,
          now,
          pausedReason: null,
          eraseCredentials: true,
        },
      );
      if (!moved) return;
      await this.outbox.append(
        IntegrationStatusChanged.create(
          integration.id,
          0,
          {
            integrationId: integration.id,
            shopId: integration.shopId,
            from: integration.status,
            to: decision.to,
            reason: 'uninstalled',
          },
          now,
        ),
      );
    });
  }

  /** WooCommerce signs with the per-integration secret kept in the sealed credentials; Shopify with the app secret. */
  private webhookSecret(integration: IntegrationRecord): string | undefined {
    if (integration.provider !== 'woocommerce') return undefined;
    if (!integration.credentialsSealed)
      throw syncProblem('invalid_webhook_signature');
    try {
      const credentials = parseCredentials(
        this.vault.open(integration.id, integration.credentialsSealed),
      );
      return credentials.provider === 'woocommerce'
        ? credentials.webhookSecret
        : undefined;
    } catch {
      this.logger.error({
        action: 'catalog-sync.credentials_unreadable',
        integrationId: integration.id,
        shopId: integration.shopId,
      });
      throw syncProblem('invalid_webhook_signature');
    }
  }
}
