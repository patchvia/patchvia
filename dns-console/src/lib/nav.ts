import {
  Building2,
  Network,
  Globe2,
  KeyRound,
  LayoutDashboard,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  keywords?: string[];
  /** Roles that see this entry; everyone when omitted */
  roles?: Role[];
  exact?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/** Single source for the sidebar and the command palette's "Pages" section. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'dns',
    label: 'DNS',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        href: '/',
        icon: LayoutDashboard,
        exact: true,
        // plain users manage their own zones; the zone list is their home
        roles: ['admin', 'operator'],
        keywords: ['overview', 'stats', 'queries'],
      },
      {
        id: 'zones',
        label: 'Zones',
        href: '/zones',
        icon: Globe2,
        keywords: ['domains', 'records'],
      },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      {
        id: 'users',
        label: 'Users',
        href: '/users',
        icon: Users,
        roles: ['admin'],
        keywords: ['roles', 'accounts', 'access'],
      },
      {
        id: 'cluster',
        label: 'Cluster',
        href: '/cluster',
        icon: Network,
        roles: ['admin'],
        keywords: [
          'nodes',
          'peers',
          'replication',
          'sync',
          'ns1',
          'high availability',
        ],
      },
      {
        id: 'accounts',
        label: 'Accounts',
        href: '/accounts',
        icon: Building2,
        roles: ['admin'],
        keywords: ['teams', 'customers', 'ownership'],
      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [
      {
        id: 'api-keys',
        label: 'API keys',
        href: '/settings/api-keys',
        icon: KeyRound,
        keywords: ['token', 'automation', 'ci'],
      },
      {
        id: 'security',
        label: 'Security',
        href: '/settings/security',
        icon: ShieldCheck,
        keywords: ['password', 'change password'],
      },
    ],
  },
];

export function visibleGroups(role: Role): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.roles || i.roles.includes(role)),
  })).filter((g) => g.items.length > 0);
}

export const ZONE_TABS = [
  { href: '', label: 'Records' },
  { href: '/history', label: 'History' },
  { href: '/settings', label: 'Settings' },
];
