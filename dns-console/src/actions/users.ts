'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type { Account, User } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const role = z.enum(['admin', 'operator', 'user']);

const createSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  role,
  accountIds: z.array(z.number().int()).default([]),
});

export async function createUserAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<User>> {
  return asUser(async (token) => {
    const user = await api<User>('users', {
      method: 'POST',
      token,
      body: createSchema.parse(input),
    });
    revalidatePath('/users');
    return user;
  });
}

const updateSchema = z.object({
  role: role.optional(),
  password: z.string().min(1).optional(),
  accountIds: z.array(z.number().int()).optional(),
});

export async function updateUserAction(
  id: number,
  input: z.input<typeof updateSchema>,
): Promise<ActionResult<User>> {
  return asUser(async (token) => {
    const user = await api<User>(`users/${id}`, {
      method: 'PATCH',
      token,
      body: updateSchema.parse(input),
    });
    revalidatePath('/users');
    return user;
  });
}

export async function deleteUserAction(id: number): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`users/${id}`, { method: 'DELETE', token });
    revalidatePath('/users');
  });
}

const accountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64),
  description: z.string().max(500).optional(),
});

export async function createAccountAction(
  input: z.input<typeof accountSchema>,
): Promise<ActionResult<Account>> {
  return asUser(async (token) => {
    const a = await api<Account>('accounts', {
      method: 'POST',
      token,
      body: accountSchema.parse(input),
    });
    revalidatePath('/accounts');
    return a;
  });
}

export async function updateAccountAction(
  id: number,
  input: z.input<typeof accountSchema>,
): Promise<ActionResult<Account>> {
  return asUser(async (token) => {
    const a = await api<Account>(`accounts/${id}`, {
      method: 'PATCH',
      token,
      body: accountSchema.parse(input),
    });
    revalidatePath('/accounts');
    return a;
  });
}

export async function deleteAccountAction(id: number): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`accounts/${id}`, { method: 'DELETE', token });
    revalidatePath('/accounts');
    revalidatePath('/zones');
  });
}
