'use client';

import { CircleCheck, CircleX, Clock, Network, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import { syncClusterAction } from '@/actions/cluster';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { peerHealth } from '@/lib/cluster-health';
import { timeAgo } from '@/lib/format';
import type { ClusterStatus } from '@/lib/types';

const SETUP = `# on each node (ns1, ns2, ns3), with that node's own id
CLUSTER_NODE_ID=ns1
CLUSTER_SECRET=<the same 32+ character secret on every node>
CLUSTER_PEERS=ns2.example.com:8081,ns3.example.com:8081
ADMIN_PASSWORD=<the same on every node, first start only>`;

export function ClusterPanel({ status }: { status: ClusterStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Keep peer status fresh while the page is open
  useEffect(() => {
    if (!status.enabled) return;
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [status.enabled, router]);

  function syncNow() {
    startTransition(async () => {
      const res = await syncClusterAction();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const failed = res.data!.filter((r) => !r.ok);
      if (failed.length)
        toast.error(
          `${failed.length} peer${failed.length === 1 ? '' : 's'} could not be reached`,
          {
            description: failed.map((f) => `${f.peer}: ${f.error}`).join('\n'),
          },
        );
      else toast.success('In sync with every peer');
      router.refresh();
    });
  }

  if (!status.enabled) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">Cluster</h1>
          <p className="text-sm text-muted-foreground">
            Run several servers that keep each other up to date
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Network className="h-4 w-4 text-muted-foreground" aria-hidden />{' '}
              Cluster mode is off
            </CardTitle>
            <CardDescription>
              With a cluster, changes made on any server (ns1, ns2, ns3) spread
              to all the others, so every nameserver gives the same answers and
              keeps answering when another is down.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              To turn it on, set these on each DNS server and restart it:
            </p>
            <pre className="overflow-auto whitespace-pre-wrap rounded-sm bg-muted p-3 font-mono text-xs">
              {SETUP}
            </pre>
            <div>
              <CopyButton value={SETUP} label="Copy" />
            </div>
            <p className="text-xs text-muted-foreground">
              Each node needs a network path to the others’ API port. Nodes
              prove themselves with the shared secret and their addresses, and
              everything between them is encrypted.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const healthy = status.peers.filter((p) => peerHealth(p) === 'ok').length;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Cluster</h1>
          <p className="text-sm text-muted-foreground">
            {status.peers.length === 0
              ? 'No peers configured yet'
              : `${healthy} of ${status.peers.length} peer${status.peers.length === 1 ? '' : 's'} connected`}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={syncNow}
          disabled={pending || status.peers.length === 0}
        >
          <RefreshCw
            className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
          />{' '}
          {pending ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" aria-hidden />{' '}
            This node: <span className="font-mono">{status.nodeId}</span>
          </CardTitle>
          <CardDescription>
            {status.entities.toLocaleString('en-US')} replicated items
            {status.tombstones
              ? `, ${status.tombstones.toLocaleString('en-US')} deletions remembered`
              : ''}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.peers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Set{' '}
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                CLUSTER_PEERS
              </code>{' '}
              to the other nodes’ addresses.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {status.peers.map((p) => {
                const h = peerHealth(p);
                return (
                  <li
                    key={p.address}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-3"
                  >
                    {h === 'ok' ? (
                      <CircleCheck
                        className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                      />
                    ) : h === 'error' ? (
                      <CircleX
                        className="h-4 w-4 shrink-0 text-destructive"
                        aria-hidden
                      />
                    ) : (
                      <Clock
                        className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="font-mono">{p.address}</span>
                        {p.nodeId && (
                          <span className="font-normal text-muted-foreground">
                            ({p.nodeId})
                          </span>
                        )}
                      </p>
                      {p.lastError ? (
                        <p
                          role="alert"
                          className="break-words text-xs text-destructive"
                        >
                          {p.lastError}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {p.lastContact
                            ? `Last contact ${timeAgo(p.lastContact)}`
                            : 'Not contacted yet'}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant={
                        h === 'ok'
                          ? 'success'
                          : h === 'error'
                            ? 'destructive'
                            : 'warning'
                      }
                    >
                      {h === 'ok'
                        ? 'Connected'
                        : h === 'error'
                          ? 'Problem'
                          : 'Joining'}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How it behaves</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Every node accepts changes, including dynamic DNS updates, and
            passes them on. Nobody has to be “the leader”.
          </p>
          <p>
            If two nodes change the <em>same</em> record set at about the same
            time, the later change wins on all of them. Changes to different
            records never clash.
          </p>
          <p>
            A node that is down catches up by itself when it returns. Zones,
            records, users, API keys, dynamic DNS tokens and DNSSEC keys are all
            kept in sync.
          </p>
          <p>
            Zone serial numbers are per node and rise on every change, so
            secondaries of any one node stay correct. Ids shown in the console
            belong to the node you are using.
          </p>
          {status.allowedAddresses.length > 0 && (
            <p className="text-xs">
              Accepting cluster traffic from:{' '}
              <span className="font-mono">
                {status.allowedAddresses.join(', ')}
              </span>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
