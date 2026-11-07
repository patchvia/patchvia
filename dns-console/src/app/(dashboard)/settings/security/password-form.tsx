'use client';

import { Check, Circle } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  changePasswordAction,
  type ChangePasswordState,
} from '@/actions/security';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/password-rules';

function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li
      className={`flex items-center gap-2 text-xs ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
    >
      {ok ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Circle className="h-3.5 w-3.5" />
      )}
      {children}
    </li>
  );
}

export function PasswordForm() {
  const [state, action] = useActionState<ChangePasswordState, FormData>(
    changePasswordAction,
    {},
  );
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (state.done) {
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
    }
  }, [state]);

  const lengthOk =
    next.length >= MIN_PASSWORD_LENGTH && next.length <= MAX_PASSWORD_LENGTH;
  const differs = next.length > 0 && next !== current;
  const matches = next.length > 0 && next === confirm;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          This is the password for the console and the API. Changing it signs
          out every other session. API keys are not affected.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex max-w-sm flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="current" className="text-sm font-medium">
              Current password
            </label>
            <Input
              id="current"
              name="current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="next" className="text-sm font-medium">
              New password
            </label>
            <Input
              id="next"
              name="next"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="confirm" className="text-sm font-medium">
              Repeat new password
            </label>
            <Input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <ul
            className="flex flex-col gap-1"
            aria-label="Password requirements"
          >
            <Rule ok={lengthOk}>
              {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters
            </Rule>
            <Rule ok={differs}>Different from the current password</Rule>
            <Rule ok={matches}>Both new passwords match</Rule>
          </ul>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          {state.done && (
            <p
              role="status"
              className="text-sm text-emerald-600 dark:text-emerald-400"
            >
              Password changed. You are still signed in here; everything else
              was signed out.
            </p>
          )}
          <div>
            <SubmitButton
              disabled={!current || !lengthOk || !differs || !matches}
            >
              Change password
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
