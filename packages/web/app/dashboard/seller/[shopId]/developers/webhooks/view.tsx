'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { developersApi, WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookEventType } from '@/lib/api/developers';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, Webhook, Trash2, RefreshCw, Activity, Check, Copy } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/lib/api/errors';
import { Badge } from '@/components/ui/badge';

export function WebhooksView() {
  const params = useParams();
  const shopId = params.shopId as string;
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Add Endpoint Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['order.paid']);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Secret Modal State
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    fetchWebhooks();
  }, [shopId]);

  const fetchWebhooks = async () => {
    try {
      const data = await developersApi.listWebhooks(shopId);
      setWebhooks(data);
    } catch (error) {
      toast.error('Failed to load webhooks');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddEndpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;
    
    setIsSubmitting(true);
    try {
      const created = await developersApi.createWebhook(shopId, { url: newUrl.trim(), events });
      setIsAddModalOpen(false);
      setNewUrl('');
      setEvents(['order.paid']);
      setRotatedSecret(created.secret); // the signing secret is shown once
      await fetchWebhooks();
      toast.success('Webhook endpoint added successfully');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to add webhook endpoint'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRotateSecret = async (webhookId: string) => {
    if (!confirm('Are you sure you want to rotate the webhook secret? The old secret stays valid for 24 hours.')) return;
    try {
      const { secret } = await developersApi.rotateWebhookSecret(shopId, webhookId);
      setRotatedSecret(secret);
      toast.success('Webhook secret rotated successfully');
    } catch (error) {
      toast.error('Failed to rotate webhook secret');
    }
  };

  const handleDeleteWebhook = async (webhookId: string) => {
    if (!confirm('Are you sure you want to delete this webhook endpoint?')) return;
    try {
      await developersApi.deleteWebhook(shopId, webhookId);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
      toast.success('Webhook deleted successfully');
    } catch (error) {
      toast.error('Failed to delete webhook');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setHasCopied(true);
    setTimeout(() => setHasCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Webhooks</h2>
          <p className="text-muted-foreground">
            Listen for events on your Marketplace account.
          </p>
        </div>

        <Dialog open={isAddModalOpen} onOpenChange={(open) => {
          setIsAddModalOpen(open);
          if (!open) setNewUrl('');
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Endpoint
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={handleAddEndpoint}>
              <DialogHeader>
                <DialogTitle>Add webhook endpoint</DialogTitle>
                <DialogDescription>
                  Enter the URL where you want to receive webhook events.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="url">Endpoint URL</Label>
                  <Input
                    id="url"
                    placeholder="https://api.example.com/webhooks"
                    type="url"
                    required
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Events</Label>
                  {WEBHOOK_EVENT_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={events.includes(type)}
                        onCheckedChange={(checked) => setEvents((prev) => (checked ? [...prev, type] : prev.filter((e) => e !== type)))}
                        aria-label={type}
                      />
                      <code>{type}</code>
                    </label>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsAddModalOpen(false)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting || !newUrl.trim() || events.length === 0}>
                  Add Endpoint
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={!!rotatedSecret} onOpenChange={(open) => !open && setRotatedSecret(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Webhook signing secret</DialogTitle>
            <DialogDescription>
              Update your backend to use this new secret to verify webhook event signatures.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center space-x-2 py-4">
            <Input readOnly value={rotatedSecret || ''} className="font-mono" />
            <Button size="icon" onClick={() => rotatedSecret && copyToClipboard(rotatedSecret)} variant="outline" className="shrink-0">
              {hasCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setRotatedSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  Loading webhooks...
                </TableCell>
              </TableRow>
            ) : webhooks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No webhook endpoints configured.
                </TableCell>
              </TableRow>
            ) : (
              webhooks.map((webhook) => (
                <TableRow key={webhook.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center space-x-2">
                      <Webhook className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-[200px] sm:max-w-[300px]" title={webhook.url}>
                        {webhook.url}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{webhook.events.join(', ')}</TableCell>
                  <TableCell>
                    <Badge variant={webhook.enabled ? 'default' : 'secondary'}>
                      {webhook.enabled ? 'Enabled' : `Disabled${webhook.disabledReason ? ` (${webhook.disabledReason})` : ''}`}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {format(new Date(webhook.createdAt), 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toast.info('Logs feature coming soon')}
                      >
                        <Activity className="h-4 w-4 mr-2" />
                        Logs
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRotateSecret(webhook.id)}
                      >
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Rotate Secret
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteWebhook(webhook.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
