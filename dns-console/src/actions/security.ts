'use server';

import { z } from 'zod';
import { api } from '@/lib/backend';
import { createSession } from '@/lib/session';
import { asUser } from './guard';

export interface ChangePasswordState {
  error?: string;
  done?: boolean;
}

const schema = z.object({
  current: z.string().min(1, 'Enter your current password'),
  next: z.string().min(1),
  confirm: z.string(),
});

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const parsed = schema.safeParse({
    current: formData.get('current') ?? '',
    next: formData.get('next') ?? '',
    confirm: formData.get('confirm') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (parsed.data.next !== parsed.data.confirm)
    return { error: 'The new passwords do not match' };

  const result = await asUser((token) =>
    api<{ token: string }>('auth/change-password', {
      method: 'POST',
      token,
      body: {
        currentPassword: parsed.data.current,
        newPassword: parsed.data.next,
      },
    }),
  );
  if (!result.ok) return { error: result.error };
  // Changing the password invalidated this session's token: swap in the fresh one so the user stays signed in
  await createSession(result.data!.token);
  return { done: true };
}
