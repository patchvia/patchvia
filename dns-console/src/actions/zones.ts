'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { api } from '@/lib/backend';
import type {
  ImportSummary,
  NotifyResult,
  RRsetChange,
  TransferResult,
  ZoneDetail,
} from '@/lib/types';
import { asUser, type ActionResult } from './guard';

const hostname = z.string().trim().min(1).max(255);

const createSchema = z.object({
  name: hostname,
  nameservers: z.array(hostname).default([]),
  kind: z.enum(['native', 'master', 'slave']).default('native'),
  accountId: z.number().int().nullable().optional(),
  masters: z.array(hostname).default([]),
});

export async function createZoneAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ name: string }>> {
  return asUser(async (token) => {
    const body = createSchema.parse(input);
    const zone = await api<ZoneDetail & { name: string }>('zones', {
      method: 'POST',
      token,
      body: {
        ...body,
        nameservers: body.nameservers.length ? body.nameservers : undefined,
      },
    });
    revalidatePath('/zones');
    return { name: zone.name };
  });
}

const changeSchema = z.object({
  name: hostname,
  type: z.enum([
    'A',
    'AAAA',
    'CNAME',
    'MX',
    'NS',
    'PTR',
    'SRV',
    'TXT',
    'CAA',
    'SOA',
  ]),
  changetype: z.enum(['REPLACE', 'DELETE']),
  ttl: z.number().int().min(0).max(2147483647).optional(),
  records: z
    .array(
      z.object({ content: z.string().min(1).max(4096), disabled: z.boolean() }),
    )
    .optional(),
});

/** Sends the staged edits as one atomic batch and returns the fresh zone. */
export async function applyChangesAction(
  zone: string,
  changes: RRsetChange[],
): Promise<ActionResult<ZoneDetail>> {
  return asUser(async (token) => {
    const rrsets = z.array(changeSchema).min(1).max(1000).parse(changes);
    const updated = await api<ZoneDetail>(
      `zones/${encodeURIComponent(zone)}/rrsets`,
      { method: 'PATCH', token, body: { rrsets } },
    );
    revalidatePath(`/zones/${zone}`);
    revalidatePath('/zones');
    return updated;
  });
}

export async function setZoneAccountAction(
  zone: string,
  accountId: number | null,
): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`zones/${encodeURIComponent(zone)}`, {
      method: 'PATCH',
      token,
      body: { accountId },
    });
    revalidatePath(`/zones/${zone}`);
    revalidatePath('/zones');
  });
}

export async function deleteZoneAction(zone: string): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`zones/${encodeURIComponent(zone)}`, { method: 'DELETE', token });
    revalidatePath('/zones');
  });
}

const importSchema = z.object({
  zonefile: z.string().min(1, 'The zone file is empty').max(8_000_000),
  name: z.string().trim().max(255).optional(),
  mode: z.enum(['create', 'replace']),
  kind: z.enum(['native', 'master']).default('native'),
  accountId: z.number().int().nullable().optional(),
  dryRun: z.boolean(),
});

/** `dryRun` previews what an import would do; without it the import is performed. */
export async function importZoneAction(
  input: z.input<typeof importSchema>,
): Promise<ActionResult<ImportSummary>> {
  return asUser(async (token) => {
    const body = importSchema.parse(input);
    const result = await api<ImportSummary>('zones/import', {
      method: 'POST',
      token,
      body: { ...body, name: body.name || undefined },
    });
    if (!body.dryRun) {
      revalidatePath('/zones');
      if (result.zone) revalidatePath(`/zones/${result.zone}`);
    }
    return result;
  });
}

export async function retrieveZoneAction(
  zone: string,
): Promise<ActionResult<TransferResult>> {
  return asUser(async (token) => {
    const result = await api<TransferResult>(
      `zones/${encodeURIComponent(zone)}/retrieve`,
      { method: 'POST', token },
    );
    revalidatePath(`/zones/${zone}`);
    revalidatePath('/zones');
    return result;
  });
}

export async function setMastersAction(
  zone: string,
  masters: string[],
): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`zones/${encodeURIComponent(zone)}`, {
      method: 'PATCH',
      token,
      body: {
        masters: z
          .array(hostname)
          .min(1, 'Add at least one primary')
          .parse(masters),
      },
    });
    revalidatePath(`/zones/${zone}`);
  });
}

export async function notifyZoneAction(
  zone: string,
): Promise<ActionResult<NotifyResult[]>> {
  return asUser(async (token) => {
    const res = await api<{ targets: NotifyResult[] }>(
      `zones/${encodeURIComponent(zone)}/notify`,
      { method: 'POST', token },
    );
    return res.targets;
  });
}

/** Turns a secondary zone into an editable primary zone. */
export async function promoteZoneAction(zone: string): Promise<ActionResult> {
  return asUser(async (token) => {
    await api(`zones/${encodeURIComponent(zone)}`, {
      method: 'PATCH',
      token,
      body: { kind: 'master' },
    });
    revalidatePath(`/zones/${zone}`);
    revalidatePath('/zones');
  });
}
