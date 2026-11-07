'use client';

import {
  CornerDownLeft,
  FileUp,
  Globe2,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import { logoutAction } from '@/actions/auth';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { visibleGroups, ZONE_TABS } from '@/lib/nav';
import { matches, parse, type Entry, type Section } from '@/lib/palette';
import type { Role } from '@/lib/types';

const SECTION_LABEL: Record<Section, string> = {
  pages: 'Pages',
  zones: 'Zones',
  actions: 'Actions',
};
const RECENTS_KEY = 'dns-console:palette:recents';
const MAX_RECENTS = 5;

function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecents(ids: string[]) {
  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(ids.slice(0, MAX_RECENTS)),
    );
  } catch {
    // storage unavailable: recents are a convenience only
  }
}

export function usePaletteOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen] as const;
}

export function CommandPalette({
  open,
  onOpenChange,
  zones,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zones: string[];
  role: Role;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setQuery('');
      setRecents(readRecents());
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const g of visibleGroups(role))
      for (const n of g.items)
        list.push({
          id: `page:${n.id}`,
          section: 'pages',
          title: n.label,
          subtitle: g.label,
          icon: n.icon,
          href: n.href,
          keywords: n.keywords ?? [],
        });
    for (const z of zones) {
      list.push({
        id: `zone:${z}`,
        section: 'zones',
        title: z,
        subtitle: 'Zone',
        icon: Globe2,
        href: `/zones/${z}`,
        keywords: ['records'],
      });
      for (const t of ZONE_TABS.filter((t) => t.href))
        list.push({
          id: `zone:${z}${t.href}`,
          section: 'zones',
          title: `${z} · ${t.label}`,
          icon: Globe2,
          href: `/zones/${z}${t.href}`,
          keywords: [z, t.label],
          searchOnly: true,
        });
    }
    if (role !== 'user') {
      list.push(
        {
          id: 'action:new-zone',
          section: 'actions',
          title: 'New zone',
          subtitle: 'Create a zone',
          icon: Plus,
          href: '/zones?new=1',
          keywords: ['create', 'add', 'domain', 'secondary'],
        },
        {
          id: 'action:import-zone',
          section: 'actions',
          title: 'Import zone file',
          subtitle: 'BIND-style zone file',
          icon: FileUp,
          href: '/zones?import=1',
          keywords: ['bind', 'upload', 'migrate', 'zonefile'],
        },
      );
    }
    list.push(
      {
        id: 'action:change-password',
        section: 'actions',
        title: 'Change password',
        subtitle: 'Update your password',
        icon: ShieldCheck,
        href: '/settings/security',
        keywords: ['security'],
      },
      {
        id: 'action:sign-out',
        section: 'actions',
        title: 'Sign out',
        icon: LogOut,
        keywords: ['log out', 'logout'],
        run: () => void logoutAction(),
      },
    );
    return list;
  }, [zones, role]);

  const choose = useCallback(
    (entry: Entry) => {
      onOpenChange(false);
      if (entry.id !== 'action:sign-out')
        writeRecents([
          entry.id,
          ...readRecents().filter((r) => r !== entry.id),
        ]);
      if (entry.run) startTransition(() => entry.run?.());
      else if (entry.href) router.push(entry.href);
    },
    [onOpenChange, router],
  );

  const { mode, text } = parse(query);
  const visible = entries.filter(
    (e) =>
      (!mode || e.section === mode) &&
      (text ? true : !e.searchOnly) &&
      matches(e, text),
  );
  const rank = (e: Entry) =>
    text && e.title.toLowerCase().startsWith(text.toLowerCase()) ? 0 : 1;
  visible.sort((a, b) => rank(a) - rank(b));
  const recentEntries =
    !mode && !text
      ? recents
          .map((id) => entries.find((e) => e.id === id))
          .filter((e): e is Entry => !!e)
      : [];
  const grouped = (['pages', 'zones', 'actions'] as Section[]).map((s) => ({
    section: s,
    items: visible.filter(
      (e) => e.section === s && !recentEntries.some((r) => r.id === e.id),
    ),
  }));

  const row = (e: Entry) => (
    <CommandItem key={e.id} value={e.id} onSelect={() => choose(e)}>
      <e.icon className="h-4 w-4 text-muted-foreground" />
      <span>{e.title}</span>
      {e.subtitle && (
        <span className="ml-auto text-xs text-muted-foreground">
          {e.subtitle}
        </span>
      )}
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a page or zone, or run an action"
      showCloseButton={false}
      className="top-[20%] translate-y-0 sm:max-w-xl"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search zones and pages…  > actions   # zones   / pages"
      />
      {/* filtering is done above; cmdk only handles keyboard selection */}
      <CommandList>
        <CommandEmpty>
          <Search className="mx-auto mb-2 h-4 w-4 text-muted-foreground" />
          Nothing matches “{query}”.
        </CommandEmpty>
        {recentEntries.length > 0 && (
          <CommandGroup heading="Recent">{recentEntries.map(row)}</CommandGroup>
        )}
        {grouped.map(
          (g) =>
            g.items.length > 0 && (
              <CommandGroup key={g.section} heading={SECTION_LABEL[g.section]}>
                {g.items.map(row)}
              </CommandGroup>
            ),
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
        <span>↑↓ to move</span>
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" /> to open · esc to close
        </span>
      </div>
    </CommandDialog>
  );
}
