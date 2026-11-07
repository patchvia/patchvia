import { loadApiKeys } from '@/lib/backend';
import { env } from '@/lib/env';
import { withSession } from '@/lib/with-session';
import { ApiKeysPanel } from './api-keys-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'API keys' };

export default async function ApiKeysPage() {
  const keys = await withSession(loadApiKeys);
  const apiUrl = env().DNS_PUBLIC_API_URL ?? env().DNS_API_URL;
  return <ApiKeysPanel keys={keys} apiUrl={apiUrl} />;
}
