import { describe, expect, it } from 'vitest';
import {
  addRecord,
  countChanges,
  diff,
  keyOf,
  moveRecord,
  removeRecord,
  restoreRecord,
  setTtl,
  toDraft,
  toRows,
  updateRecord,
} from '@/lib/rrset-draft';
import type { RRset } from '@/lib/types';

const Z = 'z.com';
const original: RRset[] = [
  {
    name: Z,
    type: 'SOA',
    ttl: 3600,
    records: [{ content: 'ns.z.com h.z.com 1 1 1 1 1', disabled: false }],
  },
  {
    name: Z,
    type: 'NS',
    ttl: 3600,
    records: [{ content: 'ns.z.com', disabled: false }],
  },
  {
    name: Z,
    type: 'A',
    ttl: 300,
    records: [
      { content: '1.1.1.1', disabled: false },
      { content: '2.2.2.2', disabled: false },
    ],
  },
  {
    name: `www.${Z}`,
    type: 'CNAME',
    ttl: 300,
    records: [{ content: Z, disabled: false }],
  },
];
const A = keyOf(Z, 'A');

describe('draft', () => {
  it('produces no changes for an untouched draft', () => {
    expect(diff(original, toDraft(original))).toEqual([]);
    expect(countChanges(toRows(original, toDraft(original), Z)).total).toBe(0);
  });

  it('adding a record to an existing RRset replaces the whole RRset', () => {
    const d = addRecord(toDraft(original), {
      name: Z,
      type: 'A',
      ttl: 300,
      content: '3.3.3.3',
    });
    expect(diff(original, d)).toEqual([
      {
        name: Z,
        type: 'A',
        changetype: 'REPLACE',
        ttl: 300,
        records: [
          { content: '1.1.1.1', disabled: false },
          { content: '2.2.2.2', disabled: false },
          { content: '3.3.3.3', disabled: false },
        ],
      },
    ]);
  });

  it('adding a record at a new name creates a new RRset', () => {
    const d = addRecord(toDraft(original), {
      name: `api.${Z}`,
      type: 'A',
      ttl: 60,
      content: '9.9.9.9',
    });
    expect(diff(original, d)).toEqual([
      {
        name: `api.${Z}`,
        type: 'A',
        changetype: 'REPLACE',
        ttl: 60,
        records: [{ content: '9.9.9.9', disabled: false }],
      },
    ]);
  });

  it('editing content and toggling disabled are modifications, others stay untouched', () => {
    let d = updateRecord(toDraft(original), A, 0, { content: '4.4.4.4' });
    d = updateRecord(d, A, 1, { disabled: true });
    const rows = toRows(original, d, Z).filter((r) => r.type === 'A');
    expect(rows.map((r) => r.status)).toEqual(['modified', 'modified']);
    expect(diff(original, d)).toHaveLength(1);
  });

  it('changing the TTL marks every record of the RRset modified', () => {
    const d = setTtl(toDraft(original), A, 60);
    const rows = toRows(original, d, Z).filter((r) => r.type === 'A');
    expect(rows.every((r) => r.status === 'modified' && r.ttlChanged)).toBe(
      true,
    );
    expect(diff(original, d)[0]).toMatchObject({
      changetype: 'REPLACE',
      ttl: 60,
    });
  });

  it('removing one of two records replaces the RRset; removing all deletes it', () => {
    let d = removeRecord(toDraft(original), A, 0);
    expect(diff(original, d)).toEqual([
      {
        name: Z,
        type: 'A',
        changetype: 'REPLACE',
        ttl: 300,
        records: [{ content: '2.2.2.2', disabled: false }],
      },
    ]);
    d = removeRecord(d, A, 1);
    expect(diff(original, d)).toEqual([
      { name: Z, type: 'A', changetype: 'DELETE' },
    ]);
    expect(countChanges(toRows(original, d, Z))).toMatchObject({
      deleted: 2,
      total: 2,
    });
  });

  it('a removal can be undone', () => {
    let d = removeRecord(toDraft(original), A, 0);
    d = restoreRecord(d, A, 0);
    expect(diff(original, d)).toEqual([]);
  });

  it('a record added then removed leaves no trace', () => {
    let d = addRecord(toDraft(original), {
      name: `tmp.${Z}`,
      type: 'A',
      ttl: 60,
      content: '5.5.5.5',
    });
    d = removeRecord(d, keyOf(`tmp.${Z}`, 'A'), 0);
    expect(diff(original, d)).toEqual([]);
    expect(d.has(keyOf(`tmp.${Z}`, 'A'))).toBe(false);
  });

  it('moving a record to another name deletes from the old RRset and adds to the new one', () => {
    const d = moveRecord(toDraft(original), keyOf(`www.${Z}`, 'CNAME'), 0, {
      name: `web.${Z}`,
      type: 'CNAME',
      ttl: 300,
      content: Z,
    });
    expect(diff(original, d)).toEqual(
      expect.arrayContaining([
        { name: `www.${Z}`, type: 'CNAME', changetype: 'DELETE' },
        {
          name: `web.${Z}`,
          type: 'CNAME',
          changetype: 'REPLACE',
          ttl: 300,
          records: [{ content: Z, disabled: false }],
        },
      ]),
    );
  });

  it('editing back to the original value yields no change', () => {
    let d = updateRecord(toDraft(original), A, 0, { content: '9.9.9.9' });
    d = updateRecord(d, A, 0, { content: '1.1.1.1' });
    expect(diff(original, d)).toEqual([]);
  });

  it('does not mutate the previous draft', () => {
    const base = toDraft(original);
    addRecord(base, { name: Z, type: 'A', ttl: 300, content: '3.3.3.3' });
    removeRecord(base, A, 0);
    expect(diff(original, base)).toEqual([]);
  });

  it('orders rows apex-first by type', () => {
    const d = addRecord(toDraft(original), {
      name: `a.${Z}`,
      type: 'A',
      ttl: 60,
      content: '8.8.8.8',
    });
    expect(
      toRows(original, d, Z).map(
        (r) => `${r.name === Z ? '@' : r.name.split('.')[0]}:${r.type}`,
      ),
    ).toEqual(['@:SOA', '@:NS', '@:A', '@:A', 'a:A', 'www:CNAME']);
  });
});

import { bulk, conflictError, rowId } from '@/lib/rrset-draft';

describe('conflictError', () => {
  const d = toDraft(original);
  it('rejects a CNAME at the apex', () => {
    expect(conflictError(d, Z, Z, 'CNAME')).toMatch(/apex/);
  });
  it('rejects a CNAME where other records exist, and other records where a CNAME exists', () => {
    expect(conflictError(d, Z, `www.${Z}`, 'A')).toMatch(/is a CNAME/);
    expect(
      conflictError(
        addRecord(d, {
          name: `x.${Z}`,
          type: 'A',
          ttl: 60,
          content: '1.1.1.1',
        }),
        Z,
        `x.${Z}`,
        'CNAME',
      ),
    ).toMatch(/only record/);
  });
  it('allows a second CNAME only if the first is the one being edited or removed', () => {
    expect(conflictError(d, Z, `www.${Z}`, 'CNAME')).toMatch(/only have one/);
    expect(
      conflictError(d, Z, `www.${Z}`, 'CNAME', {
        key: keyOf(`www.${Z}`, 'CNAME'),
        index: 0,
      }),
    ).toBeNull();
    expect(
      conflictError(
        removeRecord(d, keyOf(`www.${Z}`, 'CNAME'), 0),
        Z,
        `www.${Z}`,
        'A',
      ),
    ).toBeNull();
  });
  it('allows ordinary records at fresh names', () => {
    expect(conflictError(d, Z, `new.${Z}`, 'A')).toBeNull();
    expect(conflictError(d, Z, Z, 'MX')).toBeNull();
  });
});

describe('bulk', () => {
  it('deletes several records of one RRset, including freshly added ones, without index drift', () => {
    let d = addRecord(toDraft(original), {
      name: Z,
      type: 'A',
      ttl: 300,
      content: '3.3.3.3',
    });
    d = addRecord(d, { name: Z, type: 'A', ttl: 300, content: '4.4.4.4' });
    const ids = toRows(original, d, Z)
      .filter(
        (r) =>
          r.type === 'A' &&
          ['1.1.1.1', '3.3.3.3', '4.4.4.4'].includes(r.content),
      )
      .map(rowId);
    const next = bulk(d, ids, 'delete');
    expect(diff(original, next)).toEqual([
      {
        name: Z,
        type: 'A',
        changetype: 'REPLACE',
        ttl: 300,
        records: [{ content: '2.2.2.2', disabled: false }],
      },
    ]);
  });

  it('disables and enables selections', () => {
    const ids = toRows(original, toDraft(original), Z)
      .filter((r) => r.type === 'A')
      .map(rowId);
    const off = bulk(toDraft(original), ids, 'disable');
    expect(diff(original, off)[0]).toMatchObject({
      records: [{ disabled: true }, { disabled: true }],
    });
    expect(diff(original, bulk(off, ids, 'enable'))).toEqual([]);
  });
});
