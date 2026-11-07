'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ZONE_TABS } from '@/lib/nav';
import { cn } from '@/lib/utils';

export function ZoneTabs({ zone }: { zone: string }) {
  const pathname = usePathname();
  const base = `/zones/${zone}`;
  return (
    <nav
      aria-label="Zone sections"
      className="-mb-px flex gap-1 overflow-x-auto border-b"
    >
      {ZONE_TABS.map((t) => {
        const href = `${base}${t.href}`;
        const active =
          t.href === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={t.label}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
