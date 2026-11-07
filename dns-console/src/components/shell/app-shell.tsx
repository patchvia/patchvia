'use client';

import { LogOut, Menu, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { logoutAction } from '@/actions/auth';
import { Logo } from '@/components/brand/logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { visibleGroups } from '@/lib/nav';
import type { Role } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CommandPalette, usePaletteOpen } from './command-palette';
import { ThemeToggle } from './theme-toggle';

export function AppShell({
  user,
  zones,
  children,
}: {
  user: { username: string; role: Role };
  zones: string[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = usePaletteOpen();
  const [isMac, setIsMac] = useState(true);
  const groups = useMemo(() => visibleGroups(user.role), [user.role]);

  useEffect(() => setIsMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <div className="min-h-screen">
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <Link href="/" aria-label="Home">
            <Logo className="[&_img]:h-7" />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:text-foreground sm:w-64"
          >
            <Search className="h-4 w-4" />
            <span className="hidden flex-1 text-left sm:inline">Search…</span>
            <kbd className="hidden rounded border bg-muted px-1.5 font-sans text-[11px] sm:inline">
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>
          </button>
          <div className="hidden items-center gap-2 border-l pl-3 sm:flex">
            <span className="text-sm font-medium">{user.username}</span>
            <Badge className="capitalize">{user.role}</Badge>
          </div>
          <ThemeToggle />
          <form action={logoutAction}>
            <SubmitButton variant="ghost" size="sm" aria-label="Sign out">
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </SubmitButton>
          </form>
        </div>
      </header>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 w-60 overflow-y-auto border-r bg-card pb-6 pt-16 transition-transform lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <nav className="px-3" aria-label="Main">
          {groups.map((group, gi) => (
            <div key={group.id} className={gi > 0 ? 'mt-5' : ''}>
              <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = item.exact
                    ? pathname === item.href
                    : pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                          active
                            ? 'bg-secondary font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        {active && (
                          <span
                            aria-hidden
                            className="absolute -left-3 bottom-2 top-2 w-[3px] rounded-r bg-primary"
                          />
                        )}
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-10 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="pt-14 lg:pl-60">
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        zones={zones}
        role={user.role}
      />
    </div>
  );
}
