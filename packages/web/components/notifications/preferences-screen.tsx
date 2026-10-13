'use client';

import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { inboxErrorKind, settingsErrorText, usePreferences, useUpdatePreference } from '@/lib/api/notifications';
import { CATEGORY_LABELS, CHANNEL_LABELS } from './labels';
import { PhoneForm, PreferenceSettingsForm } from './settings-forms';

const ORDER = new Map<string, number>(NOTIFICATION_CATEGORIES.map((category, index) => [category, index]));

/** Guarded by `app/account/layout.tsx`. The whole matrix, the phone, and the quiet-hours settings of the signed-in member (S28 AS-14..AS-23). */
export function PreferencesScreen() {
  const query = usePreferences();
  const update = useUpdatePreference();

  if (query.isError) {
    const kind = inboxErrorKind(query.error).kind;
    if (kind === 'unauthenticated') return null;
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>{kind === 'rate_limited' ? 'Too many requests. Try again in a moment.' : "We couldn't load your notification settings."}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!query.data) return <p aria-busy="true" className="text-sm text-muted-foreground">Loading…</p>;

  const { settings, preferences } = query.data;
  const rows = [...preferences].sort((a, b) => (ORDER.get(a.category) ?? 0) - (ORDER.get(b.category) ?? 0));

  return (
    <div className="space-y-8">
      <section aria-labelledby="matrix-h" className="space-y-3">
        <h2 id="matrix-h" className="text-lg font-semibold">
          What we send you
        </h2>
        {!settings.phoneVerified && <p className="text-sm text-muted-foreground">Verify your phone number to turn on text messages.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Notification channels for each category</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Category
                </th>
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <th key={channel} scope="col" className="px-2 py-2 text-center font-medium">
                    {CHANNEL_LABELS[channel]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.category} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    {CATEGORY_LABELS[row.category]}
                  </th>
                  {NOTIFICATION_CHANNELS.map((channel) => {
                    const locked = row.mandatoryChannels.includes(channel);
                    const checked = locked || row.channels[channel];
                    const needsPhone = channel === 'sms' && !settings.phoneVerified && !checked;
                    return (
                      <td key={channel} className="px-2 py-2 text-center">
                        <Switch
                          aria-label={`${CATEGORY_LABELS[row.category]}: ${CHANNEL_LABELS[channel]}${locked ? ' (required)' : ''}`}
                          checked={checked}
                          disabled={locked || needsPhone}
                          onCheckedChange={(enabled) => update.mutate({ category: row.category, channel, enabled })}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Switches marked required carry notices we must send, such as security and billing messages.</p>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {settingsErrorText(update.error)}
          </p>
        )}
      </section>
      <PhoneForm settings={settings} />
      <PreferenceSettingsForm settings={settings} />
    </div>
  );
}
