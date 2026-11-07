import { Download } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ZoneTabs } from './zone-tabs';

export default async function ZoneLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const zone = decodeURIComponent(name);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          <Link href="/zones" className="hover:text-foreground">
            Zones
          </Link>
          <span aria-hidden className="px-1.5">
            /
          </span>
          <span className="text-foreground">{zone}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="break-all text-2xl font-semibold tracking-tight">
            {zone}
          </h1>
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/zones/${encodeURIComponent(zone)}/export`}
              download={`${zone}.zone`}
            >
              <Download className="h-4 w-4" /> Export zone file
            </a>
          </Button>
        </div>
      </div>
      <ZoneTabs zone={zone} />
      {children}
    </div>
  );
}
