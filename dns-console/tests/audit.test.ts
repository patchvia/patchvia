import { describe, expect, it } from 'vitest';
import { describeAudit, diffLines } from '@/lib/audit';
import type { AuditEntry } from '@/lib/types';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  at: '2026-10-14T12:00:00Z',
  actor: 'admin',
  zone: 'z.com',
  action: 'rrset.replace',
  detail: {},
  ...over,
});
const rec = (content: string, disabled = false) => ({ content, disabled });

describe('describeAudit', () => {
  it('describes zone lifecycle', () => {
    expect(describeAudit(entry({ action: 'zone.create' }))).toEqual({
      title: 'Created the zone',
      tone: 'create',
    });
    expect(describeAudit(entry({ action: 'zone.delete' })).tone).toBe('delete');
  });

  it('distinguishes added from updated record sets and shows names relative to the zone', () => {
    const added = describeAudit(
      entry({
        detail: {
          name: 'www.z.com',
          type: 'A',
          before: null,
          after: { ttl: 60, records: [rec('1.1.1.1')] },
        },
      }),
    );
    expect(added).toEqual({ title: 'Added A www (1 record)', tone: 'create' });
    const updated = describeAudit(
      entry({
        detail: {
          name: 'z.com',
          type: 'MX',
          before: { ttl: 60, records: [rec('10 a.z.com')] },
          after: { ttl: 60, records: [rec('10 a.z.com'), rec('20 b.z.com')] },
        },
      }),
    );
    expect(updated).toEqual({
      title: 'Updated MX @ (2 records)',
      tone: 'change',
    });
  });

  it('describes deletes and falls back for unknown actions', () => {
    expect(
      describeAudit(
        entry({
          action: 'rrset.delete',
          detail: { name: 'old.z.com', type: 'TXT' },
        }),
      ).title,
    ).toBe('Deleted TXT old');
    expect(describeAudit(entry({ action: 'something.new' })).title).toBe(
      'something.new',
    );
  });
});

describe('diffLines', () => {
  it('shows removed, kept and added records', () => {
    const lines = diffLines(
      entry({
        detail: {
          type: 'A',
          before: { ttl: 60, records: [rec('1.1.1.1'), rec('2.2.2.2')] },
          after: { ttl: 60, records: [rec('2.2.2.2'), rec('3.3.3.3')] },
        },
      }),
    );
    expect(lines).toEqual([
      { sign: '-', text: '1.1.1.1  (ttl 60)' },
      { sign: ' ', text: '2.2.2.2  (ttl 60)' },
      { sign: '+', text: '3.3.3.3  (ttl 60)' },
    ]);
  });

  it('treats a TTL change as remove + add, and handles creates and deletes', () => {
    const ttl = diffLines(
      entry({
        detail: {
          type: 'A',
          before: { ttl: 60, records: [rec('1.1.1.1')] },
          after: { ttl: 300, records: [rec('1.1.1.1')] },
        },
      }),
    );
    expect(ttl.map((l) => l.sign)).toEqual(['-', '+']);
    expect(
      diffLines(
        entry({
          detail: {
            type: 'A',
            before: null,
            after: { ttl: 60, records: [rec('1.1.1.1')] },
          },
        }),
      ),
    ).toEqual([{ sign: '+', text: '1.1.1.1  (ttl 60)' }]);
    expect(diffLines(entry({ action: 'zone.create', detail: {} }))).toEqual([]);
  });
});

import { lineDiff } from '@/lib/audit';

describe('lineDiff', () => {
  it('shows a whole RRset as removed when after is null', () => {
    expect(lineDiff('A', { ttl: 60, records: [rec('1.1.1.1')] }, null)).toEqual(
      [{ sign: '-', text: '1.1.1.1  (ttl 60)' }],
    );
  });
  it('marks disabled records and summarises TXT', () => {
    expect(
      lineDiff('TXT', undefined, {
        ttl: 300,
        records: [rec('"hello world"', true)],
      }),
    ).toEqual([{ sign: '+', text: 'hello world  (ttl 300, disabled)' }]);
  });
});

describe('describeAudit: replication and import', () => {
  it('describes transfers with their source, imports by mode, and primaries changes', () => {
    expect(
      describeAudit(
        entry({
          action: 'zone.transfer',
          actor: 'transfer',
          detail: { records: 12, source: '192.0.2.1:53', serial: 5 },
        }),
      ),
    ).toEqual({
      title: 'Transferred 12 records from 192.0.2.1:53',
      tone: 'change',
    });
    expect(
      describeAudit(entry({ action: 'zone.transfer', detail: {} })).title,
    ).toBe('Transferred');
    expect(
      describeAudit(
        entry({
          action: 'zone.import',
          detail: { mode: 'create', records: 1 },
        }),
      ),
    ).toEqual({
      title: 'Imported the zone from a zone file (1 record)',
      tone: 'create',
    });
    expect(
      describeAudit(
        entry({
          action: 'zone.import',
          detail: { mode: 'replace', records: 40 },
        }),
      ).tone,
    ).toBe('change');
    expect(describeAudit(entry({ action: 'zone.masters' })).title).toBe(
      'Changed the primary servers',
    );
    expect(describeAudit(entry({ action: 'zone.promote' })).title).toBe(
      'Promoted to a primary zone',
    );
  });
});

describe('describeAudit: DNSSEC and dynamic DNS', () => {
  it('describes key lifecycle with key tags', () => {
    expect(describeAudit(entry({ action: 'dnssec.enable' }))).toEqual({
      title: 'Turned on DNSSEC signing',
      tone: 'create',
    });
    expect(describeAudit(entry({ action: 'dnssec.disable' })).tone).toBe(
      'delete',
    );
    expect(
      describeAudit(
        entry({ action: 'dnssec.key.add', detail: { keyTag: 4242 } }),
      ).title,
    ).toBe('Added a DNSSEC key 4242');
    expect(
      describeAudit(
        entry({
          action: 'dnssec.key.update',
          detail: { keyTag: 4242, active: true },
        }),
      ).title,
    ).toBe('Changed DNSSEC key 4242 (now signing)');
    expect(
      describeAudit(
        entry({
          action: 'dnssec.key.update',
          detail: { keyTag: 7, active: false },
        }),
      ).title,
    ).toBe('Changed DNSSEC key 7 (stopped signing)');
    expect(
      describeAudit(entry({ action: 'dnssec.key.delete', detail: {} })).title,
    ).toBe('Deleted DNSSEC key');
  });
  it('describes dynamic DNS tokens relative to the zone', () => {
    expect(
      describeAudit(
        entry({
          action: 'dyndns.create',
          detail: { name: 'home.z.com', ttl: 60 },
        }),
      ),
    ).toEqual({
      title: 'Created a dynamic DNS token for home',
      tone: 'create',
    });
    expect(
      describeAudit(
        entry({ action: 'dyndns.delete', detail: { name: 'home.z.com' } }),
      ).title,
    ).toBe('Revoked the dynamic DNS token for home');
    expect(
      describeAudit(entry({ action: 'dyndns.create', detail: {} })).title,
    ).toBe('Created a dynamic DNS token');
  });
});

describe('describeAudit: cluster', () => {
  it('says where a synced change came from', () => {
    expect(
      describeAudit(
        entry({
          action: 'cluster.sync',
          actor: 'cluster:ns2',
          detail: { from: 'ns2' },
        }),
      ),
    ).toEqual({
      title: 'Updated from the cluster (ns2)',
      tone: 'change',
    });
    expect(
      describeAudit(entry({ action: 'cluster.sync', detail: {} })).title,
    ).toBe('Updated from the cluster');
  });
});
