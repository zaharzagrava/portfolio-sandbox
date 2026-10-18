import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { toolLabel } from '@/lib/assistant/tool-labels';
import type { ToolChip } from '@/lib/assistant/reply-reducer';

/**
 * What the assistant is looking up (W05 AS-43): one chip per tool call, keyed by the call's `id`. The text is part of the chip, so
 * state is never only an icon; the spinner stands still for people who ask for reduced motion.
 */
export function ToolChips({ tools }: { tools: ToolChip[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="flex list-none flex-wrap gap-1.5 p-0">
      {tools.map((tool) => (
        <li key={tool.id} data-status={tool.status} className="inline-flex items-center gap-1.5 rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
          {tool.status === 'running' && <CircleDashed aria-hidden="true" className="h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" />}
          {tool.status === 'done' && <CheckCircle2 aria-hidden="true" className="h-3 w-3 text-green-600" />}
          {tool.status === 'failed' && <XCircle aria-hidden="true" className="h-3 w-3 text-destructive" />}
          {toolLabel(tool.name, tool.status)}
        </li>
      ))}
    </ul>
  );
}
