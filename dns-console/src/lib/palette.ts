import type { LucideIcon } from 'lucide-react';

export type Section = 'pages' | 'zones' | 'actions';

export interface Entry {
  id: string;
  section: Section;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  keywords: string[];
  href?: string;
  run?: () => void;
  /** only offered once something is typed (keeps the empty palette short) */
  searchOnly?: boolean;
}

const PREFIXES: Record<string, Section> = {
  '/': 'pages',
  '#': 'zones',
  '>': 'actions',
};

export function parse(query: string): { mode: Section | null; text: string } {
  const first = query.trimStart()[0];
  const mode = first ? PREFIXES[first] : undefined;
  return mode
    ? { mode, text: query.trimStart().slice(1).trim() }
    : { mode: null, text: query.trim() };
}

export function matches(entry: Entry, text: string) {
  if (!text) return true;
  const hay =
    `${entry.title} ${entry.subtitle ?? ''} ${entry.keywords.join(' ')}`.toLowerCase();
  return text
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}
