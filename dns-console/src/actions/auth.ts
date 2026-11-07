'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BackendError, login } from '@/lib/backend';
import { createSession, destroySession } from '@/lib/session';

export interface LoginState {
  error?: string;
}

const schema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required').max(256),
});

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { token } = await login(parsed.data.username, parsed.data.password);
    await createSession(token);
  } catch (e) {
    if (e instanceof BackendError) return { error: e.message };
    throw e;
  }
  redirect('/');
}

export async function logoutAction() {
  await destroySession();
  redirect('/login');
}
