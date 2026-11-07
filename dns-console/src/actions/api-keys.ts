'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type { ApiKey } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64),
  scope: z.enum(['read', 'write']),
});

/** The secret is returned exactly once, here. */
export async function createApiKeyAction(
  input: z.input<typeof schema>,
): Promise<ActionResult<ApiKey & { key: string }>> {
  return asUser(async (token) => {
    const key = await api<ApiKey & { key: string }>('api-keys', {
      method: 'POST',
      token,
      body: schema.parse(input),
    });
    revalidatePath('/settings/api-keys');
    return key;
  });
}

export async function revokeApiKeyAction(id: number): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`api-keys/${id}`, { method: 'DELETE', token });
    revalidatePath('/settings/api-keys');
  });
}
