'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/backend';
import type { DnssecStatus } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const base = (zone: string) => `zones/${encodeURIComponent(zone)}/dnssec`;

function refresh(zone: string) {
  revalidatePath(`/zones/${zone}`);
  revalidatePath(`/zones/${zone}/settings`);
  revalidatePath('/zones');
}

/** Starts signing. The returned status carries the DS records to give the registrar. */
export async function enableDnssecAction(
  zone: string,
): Promise<ActionResult<DnssecStatus>> {
  return asUser(async (token) => {
    const s = await api<DnssecStatus>(base(zone), { method: 'POST', token });
    refresh(zone);
    return s;
  });
}

export async function disableDnssecAction(
  zone: string,
): Promise<ActionResult<DnssecStatus>> {
  return asUser(async (token) => {
    const s = await api<DnssecStatus>(base(zone), { method: 'DELETE', token });
    refresh(zone);
    return s;
  });
}

export async function addDnssecKeyAction(
  zone: string,
): Promise<ActionResult<DnssecStatus>> {
  return asUser(async (token) => {
    const s = await api<DnssecStatus>(`${base(zone)}/keys`, {
      method: 'POST',
      token,
    });
    refresh(zone);
    return s;
  });
}

export async function updateDnssecKeyAction(
  zone: string,
  keyId: number,
  patch: { active?: boolean; published?: boolean },
): Promise<ActionResult<DnssecStatus>> {
  return asUser(async (token) => {
    const s = await api<DnssecStatus>(`${base(zone)}/keys/${keyId}`, {
      method: 'PATCH',
      token,
      body: patch,
    });
    refresh(zone);
    return s;
  });
}

export async function deleteDnssecKeyAction(
  zone: string,
  keyId: number,
): Promise<ActionResult<DnssecStatus>> {
  return asUser(async (token) => {
    const s = await api<DnssecStatus>(`${base(zone)}/keys/${keyId}`, {
      method: 'DELETE',
      token,
    });
    refresh(zone);
    return s;
  });
}
