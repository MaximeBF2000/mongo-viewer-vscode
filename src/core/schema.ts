import type { Document } from 'mongodb';
import { bsonToWire } from './bsonCodec';
import { TYPE_LABELS, scalarToShell, type Wire } from '../shared/wire';
import type { SchemaField, SchemaResult } from '../shared/protocol';

interface Acc {
  name: string;
  path: string;
  count: number;
  nulls: number;
  types: Map<string, number>;
  samples: string[];
  children: Map<string, Acc>;
  elements?: Acc;
}

function newAcc(name: string, path: string): Acc {
  return { name, path, count: 0, nulls: 0, types: new Map(), samples: [], children: new Map() };
}

function shorten(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function record(acc: Acc, w: Wire): void {
  acc.count++;
  const label = TYPE_LABELS[w.t];
  acc.types.set(label, (acc.types.get(label) ?? 0) + 1);
  if (w.t === 'null' || w.t === 'undef') acc.nulls++;
  if (w.t === 'obj') {
    for (const [k, v] of w.e) {
      let child = acc.children.get(k);
      if (!child) {
        child = newAcc(k, acc.path ? `${acc.path}.${k}` : k);
        acc.children.set(k, child);
      }
      record(child, v);
    }
  } else if (w.t === 'arr') {
    acc.elements ??= newAcc('[]', acc.path);
    for (const item of w.a.slice(0, 50)) record(acc.elements, item);
  } else if (w.t !== 'null' && w.t !== 'undef' && acc.samples.length < 5) {
    const text = shorten(scalarToShell(w) ?? '');
    if (!acc.samples.includes(text)) acc.samples.push(text);
  }
}

function finish(acc: Acc, parentCount: number): SchemaField {
  const types = [...acc.types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  const elementTotal = acc.elements?.count ?? 0;
  const field: SchemaField = {
    name: acc.name,
    path: acc.path,
    count: acc.count,
    presence: parentCount === 0 ? 0 : Math.min(1, acc.count / parentCount),
    nulls: acc.nulls,
    types,
    samples: acc.samples,
    children: [...acc.children.values()].map((c) => finish(c, acc.count)).sort(byPresence),
  };
  if (acc.elements) {
    field.elementTypes = [...acc.elements.types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    field.samples = acc.elements.samples;
    const nested = [...acc.elements.children.values()].map((c) => finish(c, elementTotal)).sort(byPresence);
    if (nested.length) field.children = nested;
  }
  return field;
}

function byPresence(a: SchemaField, b: SchemaField): number {
  if (a.name === '_id') return -1;
  if (b.name === '_id') return 1;
  return b.presence - a.presence || a.name.localeCompare(b.name);
}

/** Infers a schema from a sample of documents. */
export function analyzeSchema(docs: Document[]): SchemaResult {
  const root = newAcc('', '');
  for (const doc of docs) record(root, bsonToWire(doc));
  return { sampled: docs.length, fields: finish(root, docs.length).children };
}

/** Flattens a schema to a list of paths, for autocomplete and AI prompts. */
export function flattenSchema(fields: SchemaField[], out: SchemaField[] = []): SchemaField[] {
  for (const f of fields) {
    out.push(f);
    flattenSchema(f.children, out);
  }
  return out;
}
