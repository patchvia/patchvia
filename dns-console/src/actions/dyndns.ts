'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type { DynToken } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const base = (zone: string) => `zones/${encodeURIComponent(zone)}/dyndns`;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(255),
  ttl: z.number().int().min(1).max(86400).optional(),
});

/** The secret token is in this result and nowhere else, ever. */
export async function createDynTokenAction(
  zone: string,
  input: z.input<typeof createSchema>,
): Promise<ActionResult<DynToken & { token: string }>> {
  return asUser(async (token) => {
    const t = await api<DynToken & { token: string }>(base(zone), {
      method: 'POST',
      token,
      body: createSchema.parse(input),
    });
    revalidatePath(`/zones/${zone}/settings`);
    return t;
  });
}

export async function deleteDynTokenAction(
  zone: string,
  id: number,
): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`${base(zone)}/${id}`, { method: 'DELETE', token });
    revalidatePath(`/zones/${zone}/settings`);
  });
}
