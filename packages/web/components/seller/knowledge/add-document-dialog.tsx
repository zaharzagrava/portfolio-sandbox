'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KNOWLEDGE_MARKDOWN_MAX_BYTES, KNOWLEDGE_PDF_MAX_BYTES, KNOWLEDGE_TITLE_MAX } from '@marketplace-sandbox/contracts';
import { DialogProblem, FieldError, fieldMessages, NativeSelect } from '@/components/seller/developers/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { UploadFailedError, useCreateDocument } from '@/lib/api/seller-knowledge';

type ProductOption = { id: string; title: string };
type Source = 'markdown' | 'pdf';

const UPLOAD_FAILED = "The file didn't upload. Choose it and try again.";
const isPdf = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

/** "Add document" (S47 `POST …/knowledge/documents`): pasted markdown, or a PDF that goes to storage with a presigned URL. */
export function AddDocumentDialog({ shopId, open, onOpenChange, products }: { shopId: string; open: boolean; onOpenChange: (open: boolean) => void; products: ProductOption[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">{open && <AddDocumentForm shopId={shopId} products={products} onOpenChange={onOpenChange} />}</DialogContent>
    </Dialog>
  );
}

function AddDocumentForm({ shopId, products, onOpenChange }: { shopId: string; products: ProductOption[]; onOpenChange: (open: boolean) => void }) {
  const create = useCreateDocument(shopId);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'SHOP_PRIVATE'>('SHOP_PRIVATE');
  const [productId, setProductId] = useState('');
  const [source, setSource] = useState<Source>('markdown');
  const [markdown, setMarkdown] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [local, setLocal] = useState<{ title?: string; source?: string }>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);

  const fields = fieldMessages(problem, ['title', 'visibility', 'productId', 'markdown', 'pdfSha256', 'pdfSize']);
  const titleError = local.title ?? fields.byField.title;
  const sourceError = local.source ?? fields.byField.markdown ?? fields.byField.pdfSha256 ?? fields.byField.pdfSize;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    setProblem(null);
    setUploadFailed(false);
    const trimmed = title.trim();
    const errors: { title?: string; source?: string } = {};
    if (!trimmed) errors.title = 'Enter a title.';
    if (source === 'markdown') {
      if (!markdown.trim()) errors.source = 'Add some text.';
      else if (new TextEncoder().encode(markdown).length > KNOWLEDGE_MARKDOWN_MAX_BYTES) errors.source = 'The text is over 1 MB.';
    } else if (!file || !isPdf(file) || file.size < 1 || file.size > KNOWLEDGE_PDF_MAX_BYTES) {
      errors.source = 'Choose a PDF file up to 20 MB.';
    }
    setLocal(errors);
    if (errors.title || errors.source) return;
    try {
      const result = await create.mutateAsync({
        title: trimmed,
        visibility: productId ? 'PUBLIC' : visibility,
        ...(productId ? { productId } : {}),
        source: source === 'markdown' ? { kind: 'markdown', markdown } : { kind: 'pdf', file: file as File },
      });
      toast.success(result.deduplicated ? 'This document is already in your library.' : 'Document added');
      onOpenChange(false);
    } catch (error) {
      if (error instanceof UploadFailedError) setUploadFailed(true);
      else setProblem(problemFromError(error));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Add document</DialogTitle>
        <DialogDescription>Documents feed the help-center assistant. Public documents about a product also answer buyers&apos; questions on its page.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="doc-title">Title</Label>
        <Input id="doc-title" value={title} maxLength={KNOWLEDGE_TITLE_MAX} autoComplete="off" aria-invalid={titleError ? true : undefined} aria-describedby={titleError ? 'doc-title-error' : undefined} onChange={(event) => setTitle(event.target.value)} />
        <FieldError id="doc-title-error">{titleError}</FieldError>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="doc-product">Product (optional)</Label>
        <NativeSelect
          id="doc-product"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            if (event.target.value) setVisibility('PUBLIC');
          }}
        >
          <option value="">No product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.title}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="doc-visibility">Visibility</Label>
        <NativeSelect id="doc-visibility" value={visibility} disabled={Boolean(productId)} aria-describedby={productId ? 'doc-visibility-note' : undefined} onChange={(event) => setVisibility(event.target.value === 'PUBLIC' ? 'PUBLIC' : 'SHOP_PRIVATE')}>
          <option value="SHOP_PRIVATE">Private to this shop</option>
          <option value="PUBLIC">Public</option>
        </NativeSelect>
        {productId && (
          <p id="doc-visibility-note" className="text-xs text-muted-foreground">
            A document about a product is public.
          </p>
        )}
        <FieldError id="doc-visibility-error">{fields.byField.visibility}</FieldError>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Source</legend>
        {(['markdown', 'pdf'] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
            <input type="radio" name="doc-source" value={value} checked={source === value} onChange={() => setSource(value)} />
            {value === 'markdown' ? 'Pasted text' : 'Upload a PDF'}
          </label>
        ))}
        {source === 'markdown' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="doc-markdown">Markdown</Label>
            <Textarea id="doc-markdown" rows={6} value={markdown} aria-invalid={sourceError ? true : undefined} aria-describedby={sourceError ? 'doc-source-error' : undefined} onChange={(event) => setMarkdown(event.target.value)} />
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="doc-file">PDF file</Label>
            <Input id="doc-file" type="file" accept="application/pdf" aria-invalid={sourceError ? true : undefined} aria-describedby={sourceError ? 'doc-source-error' : undefined} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </div>
        )}
        <FieldError id="doc-source-error">{sourceError}</FieldError>
      </fieldset>

      {uploadFailed && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          {UPLOAD_FAILED}
        </div>
      )}
      {problem && fields.alert && <DialogProblem problem={problem} resource="document" />}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          Add document
        </Button>
      </DialogFooter>
    </form>
  );
}
