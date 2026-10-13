'use client';

import { useId, useState, type FormEvent } from 'react';
import { E164_PATTERN, type NotificationSettings } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { settingsErrorText, useRequestPhoneCode, useUpdateSettings, useVerifyPhone } from '@/lib/api/notifications';

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'uk', label: 'Українська' },
];
const selectClass = 'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function zoneNames(current: string): string[] {
  const names = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return names.includes(current) ? names : [current, ...names];
}

/** The phone is proven by a 6-digit code (AS-21). Only the masked number the server returns is ever shown; the typed one is cleared on send. */
export function PhoneForm({ settings }: { settings: NotificationSettings }) {
  const phoneId = useId();
  const codeId = useId();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useUpdateSettings();
  const request = useRequestPhoneCode();
  const verify = useVerifyPhone();
  const error = localError ?? (save.isError ? settingsErrorText(save.error) : request.isError ? settingsErrorText(request.error) : verify.isError ? settingsErrorText(verify.error) : null);

  const reset = () => {
    save.reset();
    request.reset();
    verify.reset();
    setLocalError(null);
    setNotice(null);
  };

  const submitPhone = (event: FormEvent) => {
    event.preventDefault();
    reset();
    const value = phone.replace(/[\s()-]/g, '');
    if (!E164_PATTERN.test(value)) return setLocalError('Enter the number in international format, like +380501234567.');
    save.mutate(
      { phone: value },
      {
        onSuccess: () => {
          setPhone('');
          setNotice('We sent a 6-digit code to that number.');
        },
      },
    );
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    reset();
    if (!/^\d{6}$/.test(code)) return setLocalError('The code has 6 digits.');
    verify.mutate(code, {
      onSuccess: () => {
        setCode('');
        setNotice('Your phone number is verified.');
      },
    });
  };

  return (
    <section aria-labelledby={`${phoneId}-h`} className="space-y-4 rounded-xl border p-4">
      <h2 id={`${phoneId}-h`} className="text-lg font-semibold">
        Phone number
      </h2>
      <p className="text-sm text-muted-foreground">
        {settings.phone ? (
          <>
            Current number: <span>{settings.phone}</span> ({settings.phoneVerified ? 'verified' : 'not verified'}).
          </>
        ) : (
          'No phone number yet. Add one to receive text messages.'
        )}
      </p>
      <form onSubmit={submitPhone} className="flex flex-wrap items-end gap-2" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={phoneId}>{settings.phone ? 'New phone number' : 'Phone number'}</Label>
          <Input id={phoneId} type="tel" autoComplete="tel" inputMode="tel" placeholder="+380501234567" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {settings.phone ? 'Change number' : 'Send code'}
        </Button>
        {settings.phone && (
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              reset();
              save.mutate({ phone: null }, { onSuccess: () => setNotice('Phone number removed.') });
            }}
          >
            Remove number
          </Button>
        )}
      </form>
      {settings.phone && !settings.phoneVerified && (
        <form onSubmit={submitCode} className="flex flex-wrap items-end gap-2" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={codeId}>Verification code</Label>
            <Input id={codeId} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
          </div>
          <Button type="submit" disabled={verify.isPending}>
            Verify
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={request.isPending}
            onClick={() => {
              reset();
              request.mutate(undefined, { onSuccess: () => setNotice('We sent a new code.') });
            }}
          >
            Send a new code
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}

/** Quiet hours are set as a pair or cleared as a pair; the zone and language apply to the next notification (AS-19). */
export function PreferenceSettingsForm({ settings }: { settings: NotificationSettings }) {
  const id = useId();
  const [start, setStart] = useState(settings.quietStart ?? '');
  const [end, setEnd] = useState(settings.quietEnd ?? '');
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState(settings.locale);
  const save = useUpdateSettings();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ timezone, locale, quietStart: start || null, quietEnd: end || null });
  };

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-h`} className="space-y-4 rounded-xl border p-4" noValidate>
      <h2 id={`${id}-h`} className="text-lg font-semibold">
        Quiet hours, time zone and language
      </h2>
      <p className="text-sm text-muted-foreground">During quiet hours we hold push messages until they end. Security notices are never held.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-start`}>Quiet hours start</Label>
          <Input id={`${id}-start`} type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-end`}>Quiet hours end</Label>
          <Input id={`${id}-end`} type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <Input id={`${id}-tz`} list={`${id}-zones`} value={timezone} onChange={(event) => setTimezone(event.target.value)} autoComplete="off" />
          <datalist id={`${id}-zones`}>
            {zoneNames(settings.timezone).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-locale`}>Language</Label>
          <select id={`${id}-locale`} className={selectClass} value={locale} onChange={(event) => setLocale(event.target.value)}>
            {LOCALES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {!LOCALES.some((option) => option.value === locale) && <option value={locale}>{locale}</option>}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          Save settings
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setStart('');
            setEnd('');
          }}
        >
          Clear quiet hours
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {settingsErrorText(save.error)}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-sm">
          Settings saved.
        </p>
      )}
    </form>
  );
}
