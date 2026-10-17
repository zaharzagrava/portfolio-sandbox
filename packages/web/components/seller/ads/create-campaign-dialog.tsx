'use client';

import { useState, type FormEvent } from 'react';
import { AD_BUDGET_MAX_MINOR, AD_BUDGET_MIN_MINOR, AD_CPC_MAX_MINOR, AD_CPC_MIN_MINOR, AD_CURRENCY } from '@marketplace-sandbox/contracts';
import { DialogProblem, FieldError, fieldMessages, NativeSelect } from '@/components/seller/developers/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useCreateCampaign } from '@/lib/api/seller-ads';
import { fractionDigitsOf, parseMoneyInput } from '@/lib/seller/money-input';
import { formatMoney } from '@/lib/utils';

type ProductOption = { id: string; title: string };

const DIGITS = fractionDigitsOf(AD_CURRENCY);
const range = (min: number, max: number) => `Enter an amount from ${formatMoney(min, AD_CURRENCY)} to ${formatMoney(max, AD_CURRENCY)}.`;

/** The typed amount in minor units, or the sentence for the field (the API repeats the same rules). */
function amount(text: string, min: number, max: number): { minor: number } | { error: string } {
  const parsed = parseMoneyInput(text, DIGITS);
  if (!parsed.ok || parsed.minor < min || parsed.minor > max) return { error: range(min, max) };
  return { minor: parsed.minor };
}

/** "Create campaign" (S36 `POST …/ads/campaigns`): product, cost per click, daily budget, typed in euros. */
export function CreateCampaignDialog({ shopId, open, onOpenChange, products }: { shopId: string; open: boolean; onOpenChange: (open: boolean) => void; products: ProductOption[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <CreateCampaignForm shopId={shopId} products={products} onOpenChange={onOpenChange} />}</DialogContent>
    </Dialog>
  );
}

function CreateCampaignForm({ shopId, products, onOpenChange }: { shopId: string; products: ProductOption[]; onOpenChange: (open: boolean) => void }) {
  const create = useCreateCampaign(shopId);
  const [productId, setProductId] = useState('');
  const [cpc, setCpc] = useState('');
  const [budget, setBudget] = useState('');
  const [local, setLocal] = useState<{ cpc?: string; budget?: string }>({});
  const [problem, setProblem] = useState<Problem | null>(null);

  const fields = fieldMessages(problem, ['productId', 'cpcMinor', 'dailyBudgetMinor']);
  const cpcError = local.cpc ?? fields.byField.cpcMinor;
  const budgetError = local.budget ?? fields.byField.dailyBudgetMinor;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!productId || create.isPending) return;
    setProblem(null);
    const cpcMinor = amount(cpc, AD_CPC_MIN_MINOR, AD_CPC_MAX_MINOR);
    const dailyBudgetMinor = amount(budget, AD_BUDGET_MIN_MINOR, AD_BUDGET_MAX_MINOR);
    const errors = {
      ...('error' in cpcMinor ? { cpc: cpcMinor.error } : {}),
      ...('error' in dailyBudgetMinor
        ? { budget: dailyBudgetMinor.error }
        : 'minor' in cpcMinor && dailyBudgetMinor.minor < cpcMinor.minor
          ? { budget: 'The daily budget must be at least the cost per click.' }
          : {}),
    };
    setLocal(errors);
    if (!('minor' in cpcMinor) || !('minor' in dailyBudgetMinor) || Object.keys(errors).length > 0) return;
    try {
      await create.mutateAsync({ productId, cpcMinor: cpcMinor.minor, dailyBudgetMinor: dailyBudgetMinor.minor });
      onOpenChange(false);
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Create campaign</DialogTitle>
        <DialogDescription>Your product is shown as sponsored. You pay the cost per click until the daily budget is used.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="campaign-product">Product</Label>
        <NativeSelect id="campaign-product" value={productId} required aria-invalid={fields.byField.productId ? true : undefined} onChange={(event) => setProductId(event.target.value)}>
          <option value="">Choose a product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.title}
            </option>
          ))}
        </NativeSelect>
        <FieldError id="campaign-product-error">{fields.byField.productId}</FieldError>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="campaign-cpc">Cost per click (EUR)</Label>
        <Input id="campaign-cpc" inputMode="decimal" autoComplete="off" value={cpc} aria-invalid={cpcError ? true : undefined} aria-describedby={cpcError ? 'campaign-cpc-error' : undefined} onChange={(event) => setCpc(event.target.value)} />
        <FieldError id="campaign-cpc-error">{cpcError}</FieldError>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="campaign-budget">Daily budget (EUR)</Label>
        <Input id="campaign-budget" inputMode="decimal" autoComplete="off" value={budget} aria-invalid={budgetError ? true : undefined} aria-describedby={budgetError ? 'campaign-budget-error' : undefined} onChange={(event) => setBudget(event.target.value)} />
        <FieldError id="campaign-budget-error">{budgetError}</FieldError>
      </div>

      {problem && fields.alert && <DialogProblem problem={problem} resource="campaign" />}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!productId || create.isPending} aria-busy={create.isPending}>
          Create campaign
        </Button>
      </DialogFooter>
    </form>
  );
}
