import { displayName, summarise } from './records';
import type { AuditEntry, RecordType } from './types';

export type AuditTone = 'create' | 'change' | 'delete' | 'neutral';

export interface AuditView {
  title: string;
  tone: AuditTone;
}

const tag = (t: unknown) => (typeof t === 'number' ? ` ${t}` : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One readable sentence per audit entry. Names are shown relative to the zone when there is one. */
export function describeAudit(e: AuditEntry): AuditView {
  const zone = e.zone ?? '';
  const d = e.detail;
  switch (e.action) {
    case 'zone.create':
      return { title: 'Created the zone', tone: 'create' };
    case 'zone.delete':
      return { title: 'Deleted the zone', tone: 'delete' };
    case 'zone.account':
      return { title: 'Changed the zone’s account', tone: 'change' };
    case 'dnssec.enable':
      return { title: 'Turned on DNSSEC signing', tone: 'create' };
    case 'dnssec.disable':
      return { title: 'Turned off DNSSEC signing', tone: 'delete' };
    case 'dnssec.key.add':
      return { title: `Added a DNSSEC key${tag(d.keyTag)}`, tone: 'create' };
    case 'dnssec.key.update': {
      const state =
        d.active === true
          ? ' (now signing)'
          : d.active === false
            ? ' (stopped signing)'
            : '';
      return {
        title: `Changed DNSSEC key${tag(d.keyTag)}${state}`,
        tone: 'change',
      };
    }
    case 'dnssec.key.delete':
      return { title: `Deleted DNSSEC key${tag(d.keyTag)}`, tone: 'delete' };
    case 'dyndns.create': {
      const n =
        typeof d.name === 'string' ? ` for ${displayName(d.name, zone)}` : '';
      return { title: `Created a dynamic DNS token${n}`, tone: 'create' };
    }
    case 'dyndns.delete': {
      const n =
        typeof d.name === 'string' ? ` for ${displayName(d.name, zone)}` : '';
      return { title: `Revoked the dynamic DNS token${n}`, tone: 'delete' };
    }
    case 'cluster.sync':
      return {
        title: `Updated from the cluster${typeof d.from === 'string' ? ` (${d.from})` : ''}`,
        tone: 'change',
      };
    case 'zone.promote':
      return { title: 'Promoted to a primary zone', tone: 'change' };
    case 'zone.masters':
      return { title: 'Changed the primary servers', tone: 'change' };
    case 'zone.transfer': {
      const n = typeof d.records === 'number' ? d.records : undefined;
      const from = typeof d.source === 'string' ? ` from ${d.source}` : '';
      return {
        title: `Transferred${n === undefined ? '' : ` ${plural(n, 'record')}`}${from}`,
        tone: 'change',
      };
    }
    case 'zone.import': {
      const n =
        typeof d.records === 'number'
          ? ` (${plural(d.records, 'record')})`
          : '';
      return {
        title:
          d.mode === 'replace'
            ? `Replaced the records from a zone file${n}`
            : `Imported the zone from a zone file${n}`,
        tone: d.mode === 'replace' ? 'change' : 'create',
      };
    }
    case 'rrset.replace': {
      const name = displayName(d.name ?? '', zone);
      const type = d.type as RecordType;
      const n = d.after?.records.length ?? 0;
      if (!d.before)
        return {
          title: `Added ${type} ${name} (${plural(n, 'record')})`,
          tone: 'create',
        };
      return {
        title: `Updated ${type} ${name} (${plural(n, 'record')})`,
        tone: 'change',
      };
    }
    case 'rrset.delete':
      return {
        title: `Deleted ${d.type} ${displayName(d.name ?? '', zone)}`,
        tone: 'delete',
      };
    default:
      return { title: e.action, tone: 'neutral' };
  }
}

export interface DiffLine {
  sign: '+' | '-' | ' ';
  text: string;
}

interface Side {
  ttl: number;
  records: { content: string; disabled: boolean }[];
}

/** +/- lines between two versions of an RRset. A TTL change counts as a change of every record. */
export function lineDiff(
  type: RecordType,
  before: Side | null | undefined,
  after: Side | null | undefined,
): DiffLine[] {
  const fmt = (r: { content: string; disabled: boolean }, ttl: number) =>
    `${summarise(type, r.content)}  (ttl ${ttl}${r.disabled ? ', disabled' : ''})`;
  const b = before?.records.map((r) => fmt(r, before.ttl)) ?? [];
  const a = after?.records.map((r) => fmt(r, after.ttl)) ?? [];
  const lines: DiffLine[] = [];
  for (const x of b) if (!a.includes(x)) lines.push({ sign: '-', text: x });
  for (const x of a) lines.push({ sign: b.includes(x) ? ' ' : '+', text: x });
  return lines;
}

/** Before/after of an audit entry's RRset, for the history view. */
export function diffLines(e: AuditEntry): DiffLine[] {
  const type = e.detail.type as RecordType | undefined;
  return type ? lineDiff(type, e.detail.before, e.detail.after) : [];
}
