'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { SHOPIFY_DOMAIN_PATTERN } from '@marketplace-sandbox/contracts';
import { DialogProblem, FieldError, fieldMessages, Instant, PageLinks } from '@/components/seller/developers/shared';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiParseError } from '@/lib/api/parse';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useShop } from '@/lib/api/seller';
import { useConnectWoo, useInstallShopify, useIntegrations, type Integration } from '@/lib/api/seller-integrations';
import { readCursor } from '@/lib/seller/search-params';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { connectErrorCopy, isId, lagLabel, providerLabel, statusLabel, statusVariant } from './labels';

const goTo = (url: string) => window.location.assign(url);

/**
 * The integrations page of a shop (W04 F3, S08): the stores connected to it with their state, "Connect Shopify" (the API
 * returns the address to authorise at; the browser is sent there) and "Connect WooCommerce" (store address and API keys),
 * and the result of the OAuth round trip in the address (`?connected=<id>` or `?error=<code>`). The WooCommerce secret is
 * sent once and is held by nothing after the call.
 */
export function IntegrationsView({ shopId, onRedirect = goTo }: { shopId: string; /** Where the browser goes after install; replaced in tests. */ onRedirect?: (url: string) => void }) {
  const query = useSearchParams();
  const cursor = readCursor(query.get('cursor') ?? undefined);
  const connected = query.get('connected');
  const failure = query.get('error');
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'integrations.manage');
  const list = useIntegrations(shopId, { cursor });
  const base = `/dashboard/seller/${encodeURIComponent(shopId)}/integrations`;

  const columns: Column<Integration>[] = [
    {
      id: 'store',
      header: 'Store',
      primary: true,
      cell: (row) => (
        <Link href={`${base}/${encodeURIComponent(row.id)}`} className="font-medium underline-offset-4 hover:underline">
          {row.externalShop}
        </Link>
      ),
    },
    { id: 'provider', header: 'Provider', cell: (row) => providerLabel(row.provider) },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={statusVariant(row.status)}>{statusLabel(row)}</Badge> },
    { id: 'lastSync', header: 'Last sync', cell: (row) => <Instant value={row.lastSyncAt} fallback="Never" /> },
    { id: 'lag', header: 'Lag', cell: (row) => lagLabel(row.lagSeconds) },
    { id: 'products', header: 'Linked products', cell: (row) => row.linkedProducts },
    {
      id: 'attention',
      header: 'Needs attention',
      cell: (row) => (row.openQuarantine + row.openConflicts > 0 ? `${row.openQuarantine + row.openConflicts} need attention` : 'Nothing'),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">Connect a store to keep its products and stock in sync with this shop.</p>
        <p className="text-sm">
          <Link href={`${base}/offline-conflicts`} className="underline-offset-4 hover:underline">
            Offline stock conflicts
          </Link>
        </p>
      </div>

      {connected && isId(connected) && (
        <div role="status" aria-label="Connection result" className="flex flex-wrap items-center gap-3 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-950 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100">
          <p>Store connected.</p>
          <Link href={`${base}/${encodeURIComponent(connected)}`} className="underline underline-offset-4">
            Open integration
          </Link>
        </div>
      )}
      {failure && (
        <p role="alert" aria-label="Connection result" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          {connectErrorCopy(failure)}
        </p>
      )}

      {canManage && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}

      {list.isError && !list.data ? (
        <SectionError error={list.error} onRetry={() => void list.refetch()} firstPageHref={base} />
      ) : !list.data ? (
        <div role="status" aria-label="Loading integrations" className="h-32 animate-pulse rounded-lg bg-muted" />
      ) : list.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stores connected yet.</p>
      ) : (
        <div className="space-y-3">
          <ResponsiveTable caption="Connected stores" captionHidden columns={columns} rows={list.data.items} rowKey={(row) => row.id} busy={list.isPlaceholderData} />
          <PageLinks firstHref={cursor ? base : undefined} nextHref={list.data.nextCursor ? `${base}?cursor=${encodeURIComponent(list.data.nextCursor)}` : null} />
        </div>
      )}

      {canManage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ShopifyForm shopId={shopId} disabled={!writable} reason={reason} onRedirect={onRedirect} />
          <WooForm shopId={shopId} disabled={!writable} reason={reason} />
        </div>
      )}
    </div>
  );
}

function ShopifyForm({ shopId, disabled, reason, onRedirect }: { shopId: string; disabled: boolean; reason: string | null; onRedirect: (url: string) => void }) {
  const id = useId();
  const install = useInstallShopify(shopId);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit() {
    setProblem(null);
    const value = domain.trim().toLowerCase();
    if (!SHOPIFY_DOMAIN_PATTERN.test(value)) return setError('Enter your store domain, like your-store.myshopify.com.');
    setError(null);
    try {
      const { authorizeUrl } = await install.mutateAsync(value);
      // The address comes from the API; only an https one is followed.
      if (!/^https:\/\//i.test(authorizeUrl)) throw new ApiParseError();
      onRedirect(authorizeUrl);
    } catch (caught) {
      setProblem(problemFromError(caught));
    }
  }

  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-lg font-semibold">Connect Shopify</h2>
      <div className="space-y-1">
        <label htmlFor={id} className="text-sm font-medium">
          Shopify store domain
        </label>
        <Input id={id} value={domain} placeholder="your-store.myshopify.com" autoComplete="off" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} disabled={disabled} onChange={(event) => setDomain(event.target.value)} />
        <FieldError id={`${id}-error`}>{error}</FieldError>
      </div>
      {problem && <DialogProblem problem={problem} subject="requests" />}
      <Button type="submit" disabled={disabled || install.isPending} title={reason ?? undefined}>
        Connect Shopify
      </Button>
    </form>
  );
}

function WooForm({ shopId, disabled, reason }: { shopId: string; disabled: boolean; reason: string | null }) {
  const ids = { url: useId(), key: useId(), secret: useId() };
  const connect = useConnectWoo(shopId);
  const [storeUrl, setStoreUrl] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit() {
    setProblem(null);
    const found: Record<string, string> = {};
    if (!storeUrl.trim()) found.storeUrl = 'Enter the store address.';
    if (!consumerKey.trim()) found.consumerKey = 'Enter the consumer key.';
    if (!consumerSecret.trim()) found.consumerSecret = 'Enter the consumer secret.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await connect.mutateAsync({ provider: 'woocommerce', storeUrl: storeUrl.trim(), consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() });
      toast.success('Store connected');
      setStoreUrl('');
      setConsumerKey('');
      setConsumerSecret('');
    } catch (caught) {
      setProblem(problemFromError(caught));
      setConsumerSecret('');
    }
  }

  const fields = fieldMessages(problem, ['storeUrl', 'consumerKey', 'consumerSecret']);
  const message = (name: string) => errors[name] ?? fields.byField[name];

  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-lg font-semibold">Connect WooCommerce</h2>
      <div className="space-y-1">
        <label htmlFor={ids.url} className="text-sm font-medium">
          Store address
        </label>
        <Input id={ids.url} value={storeUrl} placeholder="https://shop.example.com" autoComplete="off" disabled={disabled} aria-invalid={message('storeUrl') ? true : undefined} aria-describedby={message('storeUrl') ? `${ids.url}-error` : undefined} onChange={(event) => setStoreUrl(event.target.value)} />
        <FieldError id={`${ids.url}-error`}>{message('storeUrl')}</FieldError>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.key} className="text-sm font-medium">
          Consumer key
        </label>
        <Input id={ids.key} value={consumerKey} autoComplete="off" spellCheck={false} disabled={disabled} aria-invalid={message('consumerKey') ? true : undefined} aria-describedby={message('consumerKey') ? `${ids.key}-error` : undefined} onChange={(event) => setConsumerKey(event.target.value)} />
        <FieldError id={`${ids.key}-error`}>{message('consumerKey')}</FieldError>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.secret} className="text-sm font-medium">
          Consumer secret
        </label>
        <Input id={ids.secret} type="password" value={consumerSecret} autoComplete="off" spellCheck={false} disabled={disabled} aria-invalid={message('consumerSecret') ? true : undefined} aria-describedby={message('consumerSecret') ? `${ids.secret}-error` : undefined} onChange={(event) => setConsumerSecret(event.target.value)} />
        <FieldError id={`${ids.secret}-error`}>{message('consumerSecret')}</FieldError>
        <p className="text-xs text-muted-foreground">Create a read and write key in WooCommerce, under Settings, Advanced, REST API. The secret is sent once and is not shown again.</p>
      </div>
      {problem && fields.alert && <ProblemPanel problem={problem} context={{ place: 'dialog' }} subject="requests" />}
      <Button type="submit" disabled={disabled || connect.isPending} title={reason ?? undefined}>
        Connect WooCommerce
      </Button>
    </form>
  );
}
