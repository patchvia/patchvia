'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/actions/auth';
import { Logo } from '@/components/brand/logo';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { BRAND } from '@/lib/brand';

export function LoginForm() {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <>
      <div className="fixed right-4 top-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="mb-3 [&_img]:h-12" />
          <CardTitle className="text-lg">{BRAND.tagline}</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={action} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="username" className="text-sm font-medium">
                Username
              </label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
            <SubmitButton>Sign in</SubmitButton>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
