import { compareNames, typeRank } from './records';
import type { RRset, RRsetChange, RecordType } from './types';

/**
 * Editing is staged: every change lives in a draft until the operator applies it, then it is sent to the API as
 * one atomic batch. These functions are pure so the whole flow is testable without a browser.
 */
export interface DraftRecord {
  content: string;
  disabled: boolean;
  /** Index of the record in the original RRset, undefined for records added in this draft */
  orig?: number;
  deleted?: boolean;
}

export interface DraftRRset {
  name: string;
  type: RecordType;
  ttl: number;
  records: DraftRecord[];
}

export type Draft = Map<string, DraftRRset>;

export const keyOf = (name: string, type: RecordType) => `${name}|${type}`;

export function toDraft(rrsets: RRset[]): Draft {
  return new Map(
    rrsets.map((s) => [
      keyOf(s.name, s.type),
      {
        name: s.name,
        type: s.type,
        ttl: s.ttl,
        records: s.records.map((r, i) => ({ ...r, orig: i })),
      },
    ]),
  );
}

const clone = (d: Draft): Draft =>
  new Map(
    [...d].map(([k, v]) => [
      k,
      { ...v, records: v.records.map((r) => ({ ...r })) },
    ]),
  );

export interface NewRecord {
  name: string;
  type: RecordType;
  ttl: number;
  content: string;
  disabled?: boolean;
}

/** Adds a record. When the RRset exists it joins it and the RRset takes the new TTL (TTL is per RRset in DNS). */
export function addRecord(draft: Draft, rec: NewRecord): Draft {
  const next = clone(draft);
  const key = keyOf(rec.name, rec.type);
  const set = next.get(key);
  const record: DraftRecord = {
    content: rec.content,
    disabled: rec.disabled ?? false,
  };
  if (set) {
    set.ttl = rec.ttl;
    set.records.push(record);
  } else {
    next.set(key, {
      name: rec.name,
      type: rec.type,
      ttl: rec.ttl,
      records: [record],
    });
  }
  return next;
}

export function updateRecord(
  draft: Draft,
  key: string,
  index: number,
  patch: Partial<Pick<DraftRecord, 'content' | 'disabled'>>,
): Draft {
  const next = clone(draft);
  const rec = next.get(key)?.records[index];
  if (rec) Object.assign(rec, patch);
  return next;
}

export function setTtl(draft: Draft, key: string, ttl: number): Draft {
  const next = clone(draft);
  const set = next.get(key);
  if (set) set.ttl = ttl;
  return next;
}

/** Records added in this draft vanish; stored records are marked deleted so the removal can be undone. */
export function removeRecord(draft: Draft, key: string, index: number): Draft {
  const next = clone(draft);
  const set = next.get(key);
  const rec = set?.records[index];
  if (!set || !rec) return next;
  if (rec.orig === undefined) {
    set.records.splice(index, 1);
    if (set.records.length === 0) next.delete(key);
  } else rec.deleted = true;
  return next;
}

export function restoreRecord(draft: Draft, key: string, index: number): Draft {
  const next = clone(draft);
  const rec = next.get(key)?.records[index];
  if (rec) delete rec.deleted;
  return next;
}

/** Changes where the record moves to another name or type: a delete of the old plus an add of the new. */
export function moveRecord(
  draft: Draft,
  key: string,
  index: number,
  rec: NewRecord,
): Draft {
  return addRecord(removeRecord(draft, key, index), rec);
}

const live = (s: DraftRRset) => s.records.filter((r) => !r.deleted);

const sameRecords = (
  a: { content: string; disabled: boolean }[],
  b: { content: string; disabled: boolean }[],
) =>
  a.length === b.length &&
  a.every(
    (r, i) => r.content === b[i]!.content && r.disabled === b[i]!.disabled,
  );

/** The API batch that turns `original` into `draft`. Empty when nothing changed. */
export function diff(original: RRset[], draft: Draft): RRsetChange[] {
  const changes: RRsetChange[] = [];
  const origByKey = new Map(original.map((s) => [keyOf(s.name, s.type), s]));
  for (const [key, set] of draft) {
    const orig = origByKey.get(key);
    const records = live(set).map(({ content, disabled }) => ({
      content,
      disabled,
    }));
    if (records.length === 0) {
      if (orig)
        changes.push({ name: set.name, type: set.type, changetype: 'DELETE' });
    } else if (
      !orig ||
      orig.ttl !== set.ttl ||
      !sameRecords(orig.records, records)
    ) {
      changes.push({
        name: set.name,
        type: set.type,
        changetype: 'REPLACE',
        ttl: set.ttl,
        records,
      });
    }
  }
  for (const [key, orig] of origByKey)
    if (!draft.has(key))
      changes.push({ name: orig.name, type: orig.type, changetype: 'DELETE' });
  return changes;
}

export type RowStatus = 'unchanged' | 'added' | 'modified' | 'deleted';

export interface Row {
  key: string;
  index: number;
  name: string;
  type: RecordType;
  ttl: number;
  content: string;
  disabled: boolean;
  status: RowStatus;
  /** TTL differs from the stored one, which affects every record of the RRset */
  ttlChanged: boolean;
}

export function toRows(original: RRset[], draft: Draft, zone: string): Row[] {
  const origByKey = new Map(original.map((s) => [keyOf(s.name, s.type), s]));
  const rows: Row[] = [];
  for (const [key, set] of draft) {
    const orig = origByKey.get(key);
    const ttlChanged = !!orig && orig.ttl !== set.ttl;
    set.records.forEach((r, index) => {
      const o = r.orig === undefined ? undefined : orig?.records[r.orig];
      const status: RowStatus = r.deleted
        ? 'deleted'
        : !o
          ? 'added'
          : o.content !== r.content || o.disabled !== r.disabled || ttlChanged
            ? 'modified'
            : 'unchanged';
      rows.push({
        key,
        index,
        name: set.name,
        type: set.type,
        ttl: set.ttl,
        content: r.content,
        disabled: r.disabled,
        status,
        ttlChanged,
      });
    });
  }
  return rows.sort(
    (a, b) =>
      compareNames(a.name, b.name, zone) ||
      typeRank(a.type) - typeRank(b.type) ||
      a.index - b.index,
  );
}

export function countChanges(rows: Row[]) {
  const n = { added: 0, modified: 0, deleted: 0 };
  for (const r of rows) if (r.status !== 'unchanged') n[r.status]++;
  return { ...n, total: n.added + n.modified + n.deleted };
}

/**
 * Mirrors the server's rules so the dialog can say no immediately: no CNAME at the apex, and a name holding a
 * CNAME holds nothing else (RFC 1034 3.6.2). `ignore` excludes the record being edited.
 */
export function conflictError(
  draft: Draft,
  zone: string,
  name: string,
  type: RecordType,
  ignore?: { key: string; index: number },
): string | null {
  if (type === 'CNAME' && name === zone)
    return 'A CNAME cannot sit at the zone apex (@)';
  const others: RecordType[] = [];
  for (const set of draft.values()) {
    if (set.name !== name) continue;
    set.records.forEach((r, i) => {
      if (r.deleted) return;
      if (
        ignore &&
        ignore.key === keyOf(set.name, set.type) &&
        ignore.index === i
      )
        return;
      others.push(set.type);
    });
  }
  if (type === 'CNAME') {
    if (others.some((t) => t !== 'CNAME'))
      return 'This name already has other records. A CNAME must be the only record at its name';
    if (others.includes('CNAME'))
      return 'This name already has a CNAME. A name can only have one';
  } else if (others.includes('CNAME'))
    return 'This name is a CNAME, which cannot coexist with other record types';
  return null;
}

export type BulkOp = 'delete' | 'disable' | 'enable';

/** Applies an operation to records identified by `${key}#${index}`. Processes high indexes first so splices do not shift targets. */
export function bulk(draft: Draft, ids: string[], op: BulkOp): Draft {
  const targets = ids
    .map((id) => {
      const at = id.lastIndexOf('#');
      return { key: id.slice(0, at), index: Number(id.slice(at + 1)) };
    })
    .sort((a, b) => b.index - a.index);
  let next = draft;
  for (const { key, index } of targets) {
    if (op === 'delete') next = removeRecord(next, key, index);
    else next = updateRecord(next, key, index, { disabled: op === 'disable' });
  }
  return next;
}

export const rowId = (r: { key: string; index: number }) =>
  `${r.key}#${r.index}`;
