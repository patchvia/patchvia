import type { RecordType } from './types';

/** Types an operator can create. SOA is edited through its own dialog, never added. */
export const EDITABLE_TYPES: RecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'NS',
  'SRV',
  'CAA',
  'PTR',
];

export interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  width?: 'sm' | 'md' | 'full';
  inputMode?: 'numeric';
}

export interface TypeSpec {
  label: string;
  blurb: string;
  fields: FieldSpec[];
}

export const TYPE_SPECS: Record<RecordType, TypeSpec> = {
  A: {
    label: 'A',
    blurb: 'Points a name to an IPv4 address',
    fields: [
      {
        key: 'ip',
        label: 'IPv4 address',
        placeholder: '192.0.2.10',
        width: 'full',
      },
    ],
  },
  AAAA: {
    label: 'AAAA',
    blurb: 'Points a name to an IPv6 address',
    fields: [
      {
        key: 'ip',
        label: 'IPv6 address',
        placeholder: '2001:db8::10',
        width: 'full',
      },
    ],
  },
  CNAME: {
    label: 'CNAME',
    blurb: 'Makes a name an alias of another name',
    fields: [
      {
        key: 'target',
        label: 'Target host',
        placeholder: 'app.example.com',
        width: 'full',
      },
    ],
  },
  MX: {
    label: 'MX',
    blurb: 'Where mail for the domain is delivered',
    fields: [
      {
        key: 'priority',
        label: 'Priority',
        placeholder: '10',
        width: 'sm',
        inputMode: 'numeric',
      },
      {
        key: 'host',
        label: 'Mail server',
        placeholder: 'mail.example.com',
        width: 'md',
      },
    ],
  },
  TXT: {
    label: 'TXT',
    blurb: 'Free text: SPF, DKIM, domain verification',
    fields: [
      {
        key: 'text',
        label: 'Text',
        placeholder: 'v=spf1 include:_spf.example.com ~all',
        width: 'full',
      },
    ],
  },
  NS: {
    label: 'NS',
    blurb: 'Delegates a name to a nameserver',
    fields: [
      {
        key: 'host',
        label: 'Nameserver',
        placeholder: 'ns1.example.com',
        width: 'full',
      },
    ],
  },
  SRV: {
    label: 'SRV',
    blurb: 'Locates a service (host and port)',
    fields: [
      {
        key: 'priority',
        label: 'Priority',
        placeholder: '10',
        width: 'sm',
        inputMode: 'numeric',
      },
      {
        key: 'weight',
        label: 'Weight',
        placeholder: '5',
        width: 'sm',
        inputMode: 'numeric',
      },
      {
        key: 'port',
        label: 'Port',
        placeholder: '5060',
        width: 'sm',
        inputMode: 'numeric',
      },
      {
        key: 'target',
        label: 'Target host',
        placeholder: 'sip.example.com',
        width: 'md',
      },
    ],
  },
  CAA: {
    label: 'CAA',
    blurb: 'Which certificate authorities may issue',
    fields: [
      {
        key: 'flags',
        label: 'Flags',
        placeholder: '0',
        width: 'sm',
        inputMode: 'numeric',
      },
      { key: 'tag', label: 'Tag', placeholder: 'issue', width: 'sm' },
      {
        key: 'value',
        label: 'Value',
        placeholder: 'letsencrypt.org',
        width: 'md',
      },
    ],
  },
  PTR: {
    label: 'PTR',
    blurb: 'Reverse lookup: address to name',
    fields: [
      {
        key: 'target',
        label: 'Hostname',
        placeholder: 'host.example.com',
        width: 'full',
      },
    ],
  },
  SOA: {
    label: 'SOA',
    blurb: 'Zone authority record',
    fields: [
      { key: 'mname', label: 'Primary nameserver', width: 'full' },
      { key: 'rname', label: 'Hostmaster', width: 'full' },
      { key: 'serial', label: 'Serial', width: 'sm', inputMode: 'numeric' },
      { key: 'refresh', label: 'Refresh', width: 'sm', inputMode: 'numeric' },
      { key: 'retry', label: 'Retry', width: 'sm', inputMode: 'numeric' },
      { key: 'expire', label: 'Expire', width: 'sm', inputMode: 'numeric' },
      {
        key: 'minimum',
        label: 'Negative TTL',
        width: 'sm',
        inputMode: 'numeric',
      },
    ],
  },
};

export const TTL_PRESETS = [
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 14400, label: '4 hours' },
  { value: 86400, label: '1 day' },
];

export function formatTtl(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// ---- names -----------------------------------------------------------------

/** Relative label ("www", "@", "") or FQDN to the absolute lowercase name the API stores. */
export function toFqdn(input: string, zone: string): string {
  const n = input.trim().toLowerCase().replace(/\.$/, '');
  if (n === '' || n === '@') return zone;
  if (n === zone || n.endsWith(`.${zone}`)) return n;
  return `${n}.${zone}`;
}

/** The name as shown in the editor: "@" for the apex, otherwise relative to the zone. */
export function displayName(name: string, zone: string): string {
  if (name === zone) return '@';
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}

export function nameError(
  name: string,
  opts: { wildcard?: boolean } = {},
): string | null {
  if (name.length > 253) return 'Name is longer than 253 characters';
  for (const [i, label] of name.split('.').entries()) {
    if (label.length === 0) return 'Names cannot contain empty labels';
    if (label.length > 63)
      return `"${label.slice(0, 12)}…" is longer than 63 characters`;
    if (!/^[a-z0-9_*-]+$/.test(label))
      return `"${label}" has characters DNS names cannot contain`;
    if (label.includes('*') && !(opts.wildcard && label === '*' && i === 0))
      return 'A wildcard (*) is only allowed as the first label of a record name';
  }
  return null;
}

// ---- content ---------------------------------------------------------------

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s: string): boolean {
  return IPV4.test(s);
}

export function isIPv6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return false;
  const parts = s.split('::');
  if (parts.length > 2) return false;
  const groups = (p: string) => (p ? p.split(':') : []);
  const all = [...groups(parts[0] ?? ''), ...groups(parts[1] ?? '')];
  let count = 0;
  for (const [i, g] of all.entries()) {
    if (i === all.length - 1 && g.includes('.')) {
      if (!isIPv4(g)) return false;
      count += 2;
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) count += 1;
    else return false;
  }
  return parts.length === 2 ? count < 8 : count === 8;
}

const uint = (s: string | undefined, max: number): boolean =>
  s !== undefined && /^\d+$/.test(s) && Number(s) <= max;

const host = (s: string | undefined): string | null => {
  if (!s) return 'A hostname is required';
  return nameError(s.toLowerCase().replace(/\.$/, ''));
};

/** Mirrors the server's validation so mistakes show up inline. The server stays the authority. */
export function contentError(type: RecordType, content: string): string | null {
  const c = content.trim();
  const parts = c.split(/\s+/);
  switch (type) {
    case 'A':
      return isIPv4(c) ? null : 'Enter an IPv4 address like 192.0.2.10';
    case 'AAAA':
      return isIPv6(c) ? null : 'Enter an IPv6 address like 2001:db8::10';
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return parts.length !== 1 ? 'Enter a single hostname' : host(parts[0]);
    case 'MX':
      if (parts.length !== 2) return 'Enter a priority and a mail server';
      if (!uint(parts[0], 65535))
        return 'Priority must be a number from 0 to 65535';
      return host(parts[1]);
    case 'SRV':
      if (parts.length !== 4) return 'Enter priority, weight, port and target';
      if (!uint(parts[0], 65535)) return 'Priority must be 0-65535';
      if (!uint(parts[1], 65535)) return 'Weight must be 0-65535';
      if (!uint(parts[2], 65535)) return 'Port must be 0-65535';
      return host(parts[3]);
    case 'TXT':
      return c.length === 0 ? 'Enter some text' : null;
    case 'CAA': {
      const m = /^(\d+)\s+([A-Za-z0-9]+)\s+(.+)$/s.exec(c);
      if (!m)
        return 'Enter flags, a tag and a value, for example: 0 issue "letsencrypt.org"';
      return Number(m[1]) > 255 ? 'Flags must be 0-255' : null;
    }
    case 'SOA':
      if (parts.length !== 7) return 'SOA needs 7 fields';
      return host(parts[0]) ?? host(parts[1]);
  }
}

/** Splits stored content into the fields the form edits. */
export function parseContent(
  type: RecordType,
  content: string,
): Record<string, string> {
  const c = content.trim();
  const p = c.split(/\s+/);
  switch (type) {
    case 'A':
    case 'AAAA':
      return { ip: c };
    case 'CNAME':
    case 'PTR':
      return { target: c };
    case 'NS':
      return { host: c };
    case 'MX':
      return { priority: p[0] ?? '', host: p[1] ?? '' };
    case 'SRV':
      return {
        priority: p[0] ?? '',
        weight: p[1] ?? '',
        port: p[2] ?? '',
        target: p[3] ?? '',
      };
    case 'TXT': {
      // Stored either bare or as "a" "b" strings; show the joined text
      if (!c.startsWith('"')) return { text: c };
      const strings = [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
        m[1]!.replace(/\\(["\\])/g, '$1'),
      );
      return { text: strings.join('') };
    }
    case 'CAA': {
      const m = /^(\d+)\s+(\S+)\s+(.*)$/s.exec(c);
      const value = (m?.[3] ?? '').trim();
      return {
        flags: m?.[1] ?? '0',
        tag: m?.[2] ?? 'issue',
        value:
          value.startsWith('"') && value.endsWith('"')
            ? value.slice(1, -1)
            : value,
      };
    }
    case 'SOA':
      return {
        mname: p[0] ?? '',
        rname: p[1] ?? '',
        serial: p[2] ?? '',
        refresh: p[3] ?? '',
        retry: p[4] ?? '',
        expire: p[5] ?? '',
        minimum: p[6] ?? '',
      };
  }
}

/** Builds the content string the API stores from form fields. */
export function composeContent(
  type: RecordType,
  f: Record<string, string>,
): string {
  const t = (k: string) => (f[k] ?? '').trim();
  switch (type) {
    case 'A':
    case 'AAAA':
      return t('ip');
    case 'CNAME':
    case 'PTR':
      return t('target').toLowerCase();
    case 'NS':
      return t('host').toLowerCase();
    case 'MX':
      return `${t('priority')} ${t('host').toLowerCase()}`;
    case 'SRV':
      return `${t('priority')} ${t('weight')} ${t('port')} ${t('target').toLowerCase()}`;
    case 'TXT':
      // Quote so spaces, and values over 255 bytes, survive intact
      return `"${(f.text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'CAA':
      return `${t('flags') || '0'} ${t('tag')} "${t('value')}"`;
    case 'SOA':
      return [
        'mname',
        'rname',
        'serial',
        'refresh',
        'retry',
        'expire',
        'minimum',
      ]
        .map(t)
        .join(' ');
  }
}

/** Short, human content for table cells. */
export function summarise(type: RecordType, content: string): string {
  if (type === 'TXT') return parseContent('TXT', content).text ?? content;
  if (type === 'CAA') {
    const f = parseContent('CAA', content);
    return `${f.flags} ${f.tag} "${f.value}"`;
  }
  return content;
}

// ---- ordering --------------------------------------------------------------

const TYPE_ORDER: RecordType[] = [
  'SOA',
  'NS',
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'SRV',
  'CAA',
  'PTR',
];

export const typeRank = (t: RecordType) => TYPE_ORDER.indexOf(t);

/** Apex first, then alphabetically by name, wildcards before plain labels. */
export function compareNames(a: string, b: string, zone: string): number {
  if (a === b) return 0;
  if (a === zone) return -1;
  if (b === zone) return 1;
  return a.localeCompare(b);
}
