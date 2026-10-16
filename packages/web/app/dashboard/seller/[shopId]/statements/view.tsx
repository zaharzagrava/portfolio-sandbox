'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { endOfDayKnownAt, statementCsvPath, useStatement, useStatements, type Statement } from '@/lib/api/finance';
import { formatMoney } from '@/lib/utils';

const SOURCE_COPY: Record<Statement['source'], string> = {
  live: 'Live: follows new sales as they are booked.',
  snapshot: 'Closed: frozen at the close of the month.',
  as_known_at: 'As it was known on the chosen day.',
};

export function StatementsView() {
  const { shopId } = useParams<{ shopId: string }>();
  const list = useStatements(shopId);
  const [picked, setPicked] = useState<string | undefined>();
  const [knownOn, setKnownOn] = useState('');

  const month = picked ?? list.data?.items[0]?.month;
  const knownAt = knownOn ? endOfDayKnownAt(knownOn) : undefined;
  const statement = useStatement(shopId, month, knownAt);
  const data = statement.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Statements</h1>
        <p className="text-muted-foreground">Sales, commission and payouts by month.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="statement-month">Month</Label>
          <select
            id="statement-month"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={month ?? ''}
            onChange={(e) => setPicked(e.target.value)}
            disabled={!list.data?.items.length}
          >
            {list.data?.items.map((item) => (
              <option key={item.month} value={item.month}>
                {item.month} · {item.status}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="statement-known-on">As known on</Label>
          <Input id="statement-known-on" type="date" value={knownOn} onChange={(e) => setKnownOn(e.target.value)} />
        </div>
        {month && (
          <Button variant="outline" asChild>
            <a href={statementCsvPath(shopId, month, knownAt)} download>
              Download CSV
            </a>
          </Button>
        )}
      </div>

      {list.isError || statement.isError ? (
        <p className="text-sm text-destructive">The statement is unavailable right now.</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground" data-testid="statement-empty">
          {list.isLoading || statement.isLoading ? 'Loading…' : 'No statements yet.'}
        </p>
      ) : (
        <Card data-testid="statement">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {data.month} <Badge variant="secondary">{data.status}</Badge>
            </CardTitle>
            <CardDescription>
              {SOURCE_COPY[data.source]} {data.dataAsOf ? `Data as of ${new Date(data.dataAsOf).toLocaleString()}.` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Figure label="Gross sales" testId="statement-gross" value={formatMoney(data.total.grossMinor, data.currency)} />
              <Figure label="Commission" testId="statement-commission" value={formatMoney(data.total.commissionMinor, data.currency)} />
              <Figure label="Net" testId="statement-net" value={formatMoney(data.total.netMinor, data.currency)} />
              <Figure label="Lines" testId="statement-lines" value={String(data.total.lineCount)} />
              <Figure label="Paid out" testId="statement-paid-out" value={formatMoney(data.total.payoutsPaidMinor, data.currency)} />
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Figure({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
