import {
  Binary, BSON, BSONRegExp, BSONSymbol, Code, DBRef, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID,
  type Document,
} from 'mongodb';
import { parseArrayText, parseDocumentText, parseShell, ShellSyntaxError, type Node } from '../shared/shell';
import { wireToShell, type Wire, type WireDoc } from '../shared/wire';

export const { EJSON } = BSON;

/** Reads documents without changing any type: Int32 stays Int32, 5.0 stays Double. */
export const FIDELITY_READ = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const;

const EJSON_KEYS = new Set([
  '$oid', '$date', '$numberLong', '$numberInt', '$numberDouble', '$numberDecimal', '$binary', '$uuid',
  '$regularExpression', '$timestamp', '$minKey', '$maxKey', '$symbol', '$code', '$undefined',
]);

function serr(msg: string, node: Node, src: string): ShellSyntaxError {
  return new ShellSyntaxError(msg, node.start, node.end, src);
}

function numberToBson(n: Extract<Node, { k: 'number' }>): unknown {
  // Literals written with a decimal point are Doubles even if they are whole numbers.
  if (/[.eE]/.test(n.raw) && !/^0[xX]/.test(n.raw)) return new Double(n.v);
  if (Number.isInteger(n.v) && n.v >= -2147483648 && n.v <= 2147483647) return new Int32(n.v);
  return new Double(n.v);
}

function plainNumberFilter(v: unknown): unknown {
  return v instanceof Int32 || v instanceof Double ? v.valueOf() : v;
}

function callToBson(node: Extract<Node, { k: 'call' }>, src: string): unknown {
  const args = node.args;
  const a0 = args[0];
  const str = a0?.k === 'string' ? a0.v : undefined;
  const num = a0?.k === 'number' ? a0.v : undefined;
  switch (node.name) {
    case 'ObjectId':
      return str ? new ObjectId(str) : new ObjectId();
    case 'ISODate':
    case 'Date':
      if (!a0) return new Date();
      if (str !== undefined) return new Date(str);
      if (num !== undefined && args.length === 1) return new Date(num);
      if (args.every((a) => a.k === 'number')) {
        const p = args.map((a) => (a as Extract<Node, { k: 'number' }>).v);
        return new Date(p[0], p[1] ?? 0, p[2] ?? 1, p[3] ?? 0, p[4] ?? 0, p[5] ?? 0, p[6] ?? 0);
      }
      throw serr('Date needs a string or a number of milliseconds.', a0, src);
    case 'NumberInt':
    case 'Int32': {
      const v = num ?? Number(str ?? 0);
      if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw serr('This value does not fit in an Int32.', a0 ?? node, src);
      return new Int32(v);
    }
    case 'NumberLong':
    case 'Long':
      if (str !== undefined) return Long.fromString(str);
      if (num !== undefined && !Number.isSafeInteger(num)) throw serr('Large NumberLong values must be strings to stay exact: NumberLong("9007199254740993").', a0, src);
      return Long.fromNumber(num ?? 0);
    case 'NumberDecimal':
    case 'Decimal128':
      return Decimal128.fromString(str ?? (a0?.k === 'number' ? a0.raw : '0'));
    case 'Double':
      return new Double(num ?? Number(str ?? 0));
    case 'UUID':
      return str ? new UUID(str) : new UUID();
    case 'BinData':
      return Binary.createFromBase64((args[1] as Extract<Node, { k: 'string' }>).v, (args[0] as Extract<Node, { k: 'number' }>).v);
    case 'HexData':
      return Binary.createFromHexString((args[1] as Extract<Node, { k: 'string' }>).v, (args[0] as Extract<Node, { k: 'number' }>).v);
    case 'Binary':
      if (str !== undefined) return Binary.createFromBase64(str, args[1]?.k === 'number' ? args[1].v : 0);
      throw serr('Binary() needs a base64 string.', a0 ?? node, src);
    case 'Timestamp': {
      if (a0?.k === 'object') {
        const get = (key: string) => {
          const e = a0.entries.find((x) => x.key === key);
          return e?.value.k === 'number' ? e.value.v : 0;
        };
        return new Timestamp({ t: get('t'), i: get('i') });
      }
      return new Timestamp({ t: num ?? 0, i: args[1]?.k === 'number' ? args[1].v : 0 });
    }
    case 'MinKey': return new MinKey();
    case 'MaxKey': return new MaxKey();
    case 'RegExp':
      if (str === undefined) throw serr('RegExp() needs a pattern string.', a0 ?? node, src);
      return new BSONRegExp(str, args[1]?.k === 'string' ? args[1].v : '');
    case 'Code':
      if (str === undefined) throw serr('Code() needs a string.', a0 ?? node, src);
      return new Code(str);
    case 'BSONSymbol':
      if (str === undefined) throw serr('BSONSymbol() needs a string.', a0 ?? node, src);
      return new BSONSymbol(str);
    case 'DBRef':
      if (str === undefined || !args[1]) throw serr('DBRef() needs a collection name and an id.', a0 ?? node, src);
      return new DBRef(str, nodeToBson(args[1], src) as ObjectId, args[2]?.k === 'string' ? args[2].v : undefined);
    default:
      throw serr(`Unknown function ${node.name}().`, node, src);
  }
}

/** Converts an AST into BSON values. Also accepts Extended JSON wrappers such as { $oid: "..." }. */
export function nodeToBson(node: Node, src: string): unknown {
  switch (node.k) {
    case 'string': return node.v;
    case 'number': return numberToBson(node);
    case 'bool': return node.v;
    case 'null': return null;
    case 'undefined': return undefined;
    case 'regex': return new BSONRegExp(node.pattern, node.flags.split('').sort().join(''));
    case 'array': return node.items.map((i) => nodeToBson(i, src));
    case 'call': return callToBson(node, src);
    case 'object': {
      if (node.entries.length > 0 && EJSON_KEYS.has(node.entries[0].key)) {
        return ejsonNodeToBson(node, src);
      }
      const out: Document = {};
      for (const e of node.entries) {
        if (Object.prototype.hasOwnProperty.call(out, e.key)) {
          throw new ShellSyntaxError(`The field "${e.key}" appears twice in the same document.`, e.keyLoc.start, e.keyLoc.end, src);
        }
        Object.defineProperty(out, e.key, { value: nodeToBson(e.value, src), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

function ejsonNodeToBson(node: Extract<Node, { k: 'object' }>, src: string): unknown {
  const plain = astToPlainJson(node);
  try {
    return EJSON.deserialize(plain as Document, { relaxed: false });
  } catch (err) {
    throw serr(`Invalid Extended JSON: ${(err as Error).message}`, node, src);
  }
}

function astToPlainJson(n: Node): unknown {
  switch (n.k) {
    case 'object': return Object.fromEntries(n.entries.map((e) => [e.key, astToPlainJson(e.value)]));
    case 'array': return n.items.map(astToPlainJson);
    case 'string': case 'bool': case 'number': return n.v;
    default: return null;
  }
}

/** Removes Int32/Double wrappers. Query documents and options use plain numbers. */
export function unwrapNumbers<T>(v: T): T {
  if (Array.isArray(v)) return v.map(unwrapNumbers) as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Document = {};
    for (const k of Object.keys(v as Document)) {
      Object.defineProperty(out, k, { value: unwrapNumbers((v as Document)[k]), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return plainNumberFilter(v) as T;
}

/** Parses a query field such as a filter, sort or projection. Blank text returns undefined. */
export function parseQueryDocument(text: string | undefined): Document | undefined {
  if (!text) return undefined;
  const node = parseDocumentText(text);
  return node ? unwrapNumbers(nodeToBson(node, text) as Document) : undefined;
}

/** Parses document text with exact numeric types, for inserts and replacements. */
export function parseEditableDocument(text: string): Document {
  const node = parseDocumentText(text);
  if (!node) throw new ShellSyntaxError('The document is empty. It must be a document in { curly braces }.', 0, 0, text);
  return nodeToBson(node, text) as Document;
}

/** Parses a single value with exact types, for inline field edits. */
export function parseEditableValue(text: string): unknown {
  return nodeToBson(parseShell(text), text);
}

export function parsePipeline(text: string): Document[] {
  const node = parseArrayText(text);
  if (!node) return [];
  return unwrapNumbers(nodeToBson(node, text) as Document[]);
}

const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
const tagOf = (v: object) => (v as { _bsontype?: string })._bsontype;

/** Converts any BSON or JS value to its Wire form. */
export function bsonToWire(v: unknown, depth = 0): Wire {
  if (depth > 200) return { t: 'str', v: '[nested too deeply]' };
  switch (typeof v) {
    case 'string': return { t: 'str', v };
    case 'boolean': return { t: 'bool', v };
    case 'undefined': return { t: 'undef' };
    case 'bigint': return { t: 'long', v: v.toString() };
    case 'function': return { t: 'code', v: String(v) };
    case 'symbol': return { t: 'str', v: String(v) };
    case 'number':
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) return { t: 'int', v };
      return { t: 'dbl', v: Number.isFinite(v) ? v : (String(v) as 'NaN') };
  }
  if (v === null) return { t: 'null' };
  const obj = v as object;
  switch (tagOf(obj)) {
    case 'ObjectId': case 'ObjectID': return { t: 'oid', v: (obj as ObjectId).toHexString() };
    case 'Int32': return { t: 'int', v: (obj as Int32).valueOf() };
    case 'Double': {
      const d = (obj as Double).valueOf();
      return { t: 'dbl', v: Number.isFinite(d) ? d : (String(d) as 'NaN') };
    }
    case 'Long': return { t: 'long', v: (obj as Long).toString() };
    case 'Decimal128': return { t: 'dec', v: (obj as Decimal128).toString() };
    case 'Binary': {
      const bin = obj as Binary;
      if (bin.sub_type === 4 && bin.position === 16) {
        const h = hexOf(bin.buffer.subarray(0, 16));
        return { t: 'uuid', v: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` };
      }
      return { t: 'bin', sub: bin.sub_type, b64: bin.toString('base64'), size: bin.position };
    }
    case 'BSONRegExp': return { t: 'regex', p: (obj as BSONRegExp).pattern, f: (obj as BSONRegExp).options };
    case 'Timestamp': {
      const ts = obj as Timestamp;
      return { t: 'ts', time: ts.getHighBitsUnsigned(), inc: ts.getLowBitsUnsigned() };
    }
    case 'MinKey': return { t: 'min' };
    case 'MaxKey': return { t: 'max' };
    case 'Code': return { t: 'code', v: String((obj as Code).code) };
    case 'BSONSymbol': return { t: 'sym', v: (obj as BSONSymbol).valueOf() };
    case 'DBRef': {
      const r = obj as DBRef;
      return { t: 'dbref', coll: r.collection, id: bsonToWire(r.oid, depth + 1), db: r.db };
    }
  }
  const tag = Object.prototype.toString.call(obj);
  if (tag === '[object Date]') {
    const ms = (obj as Date).getTime();
    return Number.isNaN(ms) ? { t: 'date', v: null } : { t: 'date', v: (obj as Date).toISOString(), ms };
  }
  if (tag === '[object RegExp]') return { t: 'regex', p: (obj as RegExp).source, f: (obj as RegExp).flags };
  if (Array.isArray(obj)) return { t: 'arr', a: obj.map((x) => bsonToWire(x, depth + 1)) };
  if (obj instanceof Map || tag === '[object Map]') {
    return { t: 'obj', e: [...(obj as Map<unknown, unknown>)].map(([k, x]) => [String(k), bsonToWire(x, depth + 1)]) };
  }
  if (ArrayBuffer.isView(obj)) {
    const b = Buffer.from(obj.buffer, obj.byteOffset, obj.byteLength);
    return { t: 'bin', sub: 0, b64: b.toString('base64'), size: b.length };
  }
  if (tag === '[object Error]') return { t: 'str', v: String((obj as Error).message) };
  const maybeToJson = obj as { toJSON?: () => unknown };
  if (typeof maybeToJson.toJSON === 'function' && Object.getPrototypeOf(obj) !== Object.prototype && !isPlainFromOtherRealm(obj)) {
    return bsonToWire(maybeToJson.toJSON(), depth + 1);
  }
  return { t: 'obj', e: Object.keys(obj).map((k) => [k, bsonToWire((obj as Document)[k], depth + 1)]) };
}

// Objects made inside a playground's vm context have a different Object.prototype.
function isPlainFromOtherRealm(o: object): boolean {
  const proto = Object.getPrototypeOf(o);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function encodeId(id: unknown): string {
  return EJSON.stringify(id as Document, { relaxed: false });
}

export function decodeId(id: string): unknown {
  return EJSON.parse(id, { relaxed: false });
}

export function docToWire(doc: Document): WireDoc {
  const hasId = Object.prototype.hasOwnProperty.call(doc, '_id');
  return { id: hasId ? encodeId(doc._id) : null, value: bsonToWire(doc) };
}

/** Editor text for a document. */
export function docToShell(doc: Document): string {
  return wireToShell(bsonToWire(doc));
}

/** A stable fingerprint used to detect changes made elsewhere. */
export function fingerprint(doc: Document): string {
  return EJSON.stringify(doc, { relaxed: false });
}

/** Recursively parses imported Extended JSON. */
export function parseImportText(text: string): Document[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('[')) {
    const parsed = EJSON.parse(text, { relaxed: true }) as unknown;
    if (!Array.isArray(parsed)) throw new Error('The file does not contain an array of documents.');
    return parsed as Document[];
  }
  // A single document or newline-delimited documents.
  try {
    const single = EJSON.parse(text, { relaxed: true });
    return Array.isArray(single) ? (single as Document[]) : [single as Document];
  } catch {
    return text
      .split(/\r?\n/)
      .map((l, i) => [l.trim(), i] as const)
      .filter(([l]) => l.length > 0)
      .map(([l, i]) => {
        try {
          return EJSON.parse(l, { relaxed: true }) as Document;
        } catch (err) {
          throw new Error(`Line ${i + 1}: ${(err as Error).message}`);
        }
      });
  }
}

export { ShellSyntaxError };
