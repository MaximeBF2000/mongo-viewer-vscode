// JSON-safe, type-preserving representation of BSON values. The extension host
// converts documents to Wire before sending them to a webview, so the webview
// never needs the BSON library and no type information is lost.

export type Wire =
  | { t: 'str'; v: string }
  | { t: 'int'; v: number }
  | { t: 'dbl'; v: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { t: 'long'; v: string }
  | { t: 'dec'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'undef' }
  | { t: 'oid'; v: string }
  | { t: 'date'; v: string | null; ms?: number }
  | { t: 'regex'; p: string; f: string }
  | { t: 'bin'; sub: number; b64: string; size: number }
  | { t: 'uuid'; v: string }
  | { t: 'ts'; time: number; inc: number }
  | { t: 'min' }
  | { t: 'max' }
  | { t: 'code'; v: string }
  | { t: 'dbref'; coll: string; id: Wire; db?: string }
  | { t: 'sym'; v: string }
  | { t: 'obj'; e: [string, Wire][] }
  | { t: 'arr'; a: Wire[] };

/** A document as sent to the webview. `id` is the canonical EJSON of `_id`. */
export interface WireDoc { id: string | null; value: Wire }

const BARE_KEY = /^[A-Za-z_$][\w$]*$/;
export const formatKey = (k: string) => (BARE_KEY.test(k) ? k : JSON.stringify(k));

function numberText(v: number | string): string {
  if (typeof v === 'string') return v;
  if (Object.is(v, -0)) return '-0.0';
  if (!Number.isFinite(v)) return String(v);
  const s = String(v);
  // A Double always shows a decimal point (or exponent) so it stays a Double on save.
  return /[.eE]/.test(s) ? s : s + '.0';
}

/** A one-line shell literal for scalars, or the compact form for containers. */
export function scalarToShell(w: Wire): string | null {
  switch (w.t) {
    case 'str': return JSON.stringify(w.v);
    case 'int': return String(w.v);
    case 'dbl': return numberText(w.v);
    case 'long': return `NumberLong("${w.v}")`;
    case 'dec': return `Decimal128("${w.v}")`;
    case 'bool': return String(w.v);
    case 'null': return 'null';
    case 'undef': return 'undefined';
    case 'oid': return `ObjectId("${w.v}")`;
    case 'date': return w.v === null ? `new Date(${w.ms ?? 'NaN'})` : `ISODate("${w.v}")`;
    case 'regex': return `/${w.p || '(?:)'}/${w.f}`;
    case 'bin': return `BinData(${w.sub}, "${w.b64}")`;
    case 'uuid': return `UUID("${w.v}")`;
    case 'ts': return `Timestamp({ t: ${w.time}, i: ${w.inc} })`;
    case 'min': return 'MinKey()';
    case 'max': return 'MaxKey()';
    case 'code': return `Code(${JSON.stringify(w.v)})`;
    case 'sym': return `BSONSymbol(${JSON.stringify(w.v)})`;
    case 'dbref': return `DBRef(${JSON.stringify(w.coll)}, ${wireToShell(w.id, false)}${w.db ? `, ${JSON.stringify(w.db)}` : ''})`;
    default: return null;
  }
}

function isInlineArray(w: Extract<Wire, { t: 'arr' }>): boolean {
  if (w.a.length > 12) return false;
  let len = 0;
  for (const item of w.a) {
    const s = scalarToShell(item);
    if (s === null) return false;
    len += s.length + 2;
    if (len > 70) return false;
  }
  return true;
}

/** Shell-syntax text. Pretty output is what the document editor shows, and it round-trips exactly. */
export function wireToShell(w: Wire, pretty = true, indent = ''): string {
  const scalar = scalarToShell(w);
  if (scalar !== null) return scalar;
  const next = indent + '  ';
  if (w.t === 'arr') {
    if (w.a.length === 0) return '[]';
    if (!pretty || isInlineArray(w)) return `[${w.a.map((x) => wireToShell(x, false)).join(', ')}]`;
    return `[\n${w.a.map((x) => next + wireToShell(x, true, next)).join(',\n')}\n${indent}]`;
  }
  if (w.t === 'obj') {
    if (w.e.length === 0) return '{}';
    if (!pretty) return `{ ${w.e.map(([k, v]) => `${formatKey(k)}: ${wireToShell(v, false)}`).join(', ')} }`;
    return `{\n${w.e.map(([k, v]) => `${next}${formatKey(k)}: ${wireToShell(v, true, next)}`).join(',\n')}\n${indent}}`;
  }
  return '';
}

export const TYPE_LABELS: Record<Wire['t'], string> = {
  str: 'String', int: 'Int32', dbl: 'Double', long: 'Long', dec: 'Decimal128', bool: 'Boolean', null: 'Null',
  undef: 'Undefined', oid: 'ObjectId', date: 'Date', regex: 'Regex', bin: 'Binary', uuid: 'UUID', ts: 'Timestamp',
  min: 'MinKey', max: 'MaxKey', code: 'Code', dbref: 'DBRef', sym: 'Symbol', obj: 'Object', arr: 'Array',
};

/** Value as plain text: what "Copy value" puts on the clipboard. */
export function wireToCopyText(w: Wire): string {
  switch (w.t) {
    case 'str': case 'oid': case 'long': case 'dec': case 'uuid': case 'code': case 'sym': return w.v;
    case 'int': case 'bool': return String(w.v);
    case 'dbl': return String(w.v);
    case 'date': return w.v ?? 'Invalid Date';
    default: return wireToShell(w, true);
  }
}

/** A cell value for CSV export. */
export function wireToCsvCell(w: Wire): string {
  switch (w.t) {
    case 'null': case 'undef': return '';
    case 'obj': case 'arr': return wireToShell(w, false);
    case 'bin': return w.b64;
    case 'regex': return `/${w.p}/${w.f}`;
    default: return wireToCopyText(w);
  }
}

export function getPath(w: Wire | undefined, path: string[]): Wire | undefined {
  let cur = w;
  for (const seg of path) {
    if (!cur) return undefined;
    if (cur.t === 'obj') cur = cur.e.find(([k]) => k === seg)?.[1];
    else if (cur.t === 'arr') cur = cur.a[Number(seg)];
    else return undefined;
  }
  return cur;
}

/** Flattens a document to dotted paths for CSV. Arrays stay single cells. */
export function flattenWire(w: Wire, prefix = '', out: [string, Wire][] = []): [string, Wire][] {
  if (w.t === 'obj' && (prefix === '' || w.e.length > 0)) {
    for (const [k, v] of w.e) flattenWire(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push([prefix, w]);
  }
  return out;
}

/** Field paths in a document, for autocomplete. Descends into objects and arrays of objects. */
export function collectPaths(w: Wire, prefix: string, out: Set<string>, depth = 0): void {
  if (depth > 5) return;
  if (w.t === 'obj') {
    for (const [k, v] of w.e) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      collectPaths(v, p, out, depth + 1);
    }
  } else if (w.t === 'arr') {
    for (const item of w.a.slice(0, 5)) if (item.t === 'obj') collectPaths(item, prefix, out, depth + 1);
  }
}
