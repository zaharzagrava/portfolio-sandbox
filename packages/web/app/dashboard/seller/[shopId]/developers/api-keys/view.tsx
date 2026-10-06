'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_SCOPES, developersApi, type ApiKey, type ApiScope } from '@/lib/api/developers';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
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
import { Plus, KeyIcon, Trash2, RefreshCw, Copy, Check } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

export function ApiKeysView() {
  const params = useParams();
  const shopId = params.shopId as string;
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Generate Key Modal State
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['products:read']);
  const [livemode, setLivemode] = useState(false);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);

  useEffect(() => {
    fetchKeys();
  }, [shopId]);

  const fetchKeys = async () => {
    try {
      const data = await developersApi.listKeys(shopId);
      setKeys(data);
    } catch (error) {
      toast.error('Failed to load API keys');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    
    setIsSubmitting(true);
    try {
      const created = await developersApi.createKey(shopId, { name: newKeyName.trim(), scopes, livemode });
      setGeneratedSecret(created.key);
      await fetchKeys();
      toast.success('API Key generated successfully');
    } catch (error) {
      toast.error('Failed to generate API key');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRotateKey = async (keyId: string) => {
    if (!confirm('Rotate this key? The old key keeps working for a short overlap window, then stops.')) return;
    try {
      const rotated = await developersApi.rotateKey(shopId, keyId);
      setGeneratedSecret(rotated.key);
      await fetchKeys();
      setIsGenerateModalOpen(true);
      toast.success('API Key rotated successfully');
    } catch (error) {
      toast.error('Failed to rotate API key');
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!confirm('Are you sure you want to revoke this key? This action cannot be undone.')) return;
    try {
      await developersApi.revokeKey(shopId, keyId);
      await fetchKeys();
      toast.success('API Key revoked successfully');
    } catch (error) {
      toast.error('Failed to revoke API key');
    }
  };

  const copyToClipboard = () => {
    if (!generatedSecret) return;
    navigator.clipboard.writeText(generatedSecret);
    setHasCopied(true);
    setTimeout(() => setHasCopied(false), 2000);
  };

  const closeAndResetModal = () => {
    setIsGenerateModalOpen(false);
    setNewKeyName('');
    setScopes(['products:read']);
    setLivemode(false);
    setGeneratedSecret(null);
    setHasCopied(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground">
            Manage API keys for accessing the Marketplace API.
          </p>
        </div>

        <Dialog open={isGenerateModalOpen} onOpenChange={(open) => {
          if (!open) closeAndResetModal();
          else setIsGenerateModalOpen(true);
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Generate Key
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{generatedSecret ? 'Save your API key' : 'Generate new API key'}</DialogTitle>
              <DialogDescription>
                {generatedSecret
                  ? 'Please copy this key now. You will not be able to see it again.'
                  : 'Create a new API key to authenticate your requests.'}
              </DialogDescription>
            </DialogHeader>

            {generatedSecret ? (
              <div className="space-y-4 py-4">
                <div className="flex items-center space-x-2">
                  <Input readOnly value={generatedSecret} className="font-mono" />
                  <Button size="icon" onClick={copyToClipboard} variant="outline" className="shrink-0">
                    {hasCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleGenerateKey}>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Key Name</Label>
                    <Input
                      id="name"
                      placeholder="e.g. Production App"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      disabled={isSubmitting}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Scopes</Label>
                    {API_SCOPES.map((scope) => (
                      <label key={scope} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={scopes.includes(scope)}
                          onCheckedChange={(checked) => setScopes((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)))}
                          aria-label={scope}
                        />
                        <code>{scope}</code>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={livemode} onCheckedChange={setLivemode} aria-label="Live mode" />
                    {livemode ? 'Live key (sk_live_) - acts on real data' : 'Test key (sk_test_) - acts on the sandbox'}
                  </label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeAndResetModal} disabled={isSubmitting}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting || !newKeyName.trim() || scopes.length === 0}>
                    Generate Key
                  </Button>
                </DialogFooter>
              </form>
            )}
            
            {generatedSecret && (
              <DialogFooter>
                <Button onClick={closeAndResetModal}>Done</Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key Prefix</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading keys...
                </TableCell>
              </TableRow>
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No API keys found. Generate one to get started.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => (
                <TableRow key={key.id} data-testid="api-key-row" className={key.revokedAt ? 'opacity-50' : undefined}>
                  <TableCell className="font-medium">
                    <div className="flex items-center space-x-2">
                      <KeyIcon className="h-4 w-4 text-muted-foreground" />
                      <span>{key.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="bg-muted px-2 py-1 rounded text-sm font-mono">
                      {key.prefix}
                    </code>
                    {!key.livemode && <span className="ml-2 text-xs text-muted-foreground">test</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{key.scopes.join(', ')}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {format(new Date(key.createdAt), 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {key.lastUsedAt ? format(new Date(key.lastUsedAt), 'MMM d, yyyy') : 'Never'}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.revokedAt ? (
                      <span className="text-sm text-muted-foreground">Revoked</span>
                    ) : (
                    <div className="flex items-center justify-end space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRotateKey(key.id)}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Rotate
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevokeKey(key.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Revoke
                      </Button>
                    </div>
                    )}
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
