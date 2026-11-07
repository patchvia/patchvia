'use server';

import { revalidatePath } from 'next/cache';
import { syncCluster } from '@/lib/backend';
import type { ClusterSyncResult } from '@/lib/types';
import { asUser, type ActionResult } from './guard';

/** Asks this node to pull from every peer right now. */
export async function syncClusterAction(): Promise<
  ActionResult<ClusterSyncResult[]>
> {
  return asUser(async (token) => {
    const { results } = await syncCluster(token);
    revalidatePath('/cluster');
    return results;
  });
}
