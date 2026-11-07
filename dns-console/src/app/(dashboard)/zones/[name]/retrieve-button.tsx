'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { retrieveZoneAction } from '@/actions/zones';
import { Button, type ButtonProps } from '@/components/ui/button';

/** Pulls a secondary zone from its primary right now, regardless of serials. */
export function RetrieveButton({
  zone,
  ...props
}: { zone: string } & ButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const res = await retrieveZoneAction(zone);
      if (!res.ok) {
        toast.error('Transfer failed', { description: res.error });
      } else {
        toast.success(`Transferred ${res.data!.records} records`, {
          description: `Serial is now ${res.data!.serial}`,
        });
      }
      router.refresh();
    });
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      disabled={pending}
      {...props}
    >
      <RefreshCw
        className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
      />
      {pending ? 'Transferring…' : 'Retrieve now'}
    </Button>
  );
}
