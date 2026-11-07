// The mongosh-like API available inside playground scripts. It wraps the official
// driver, and adds shell conveniences such as find(filter, projection).
import * as vm from 'node:vm';
import {
  Binary, BSONRegExp, BSONSymbol, Code, DBRef, Decimal128, Double, Int32, Long, MaxKey, MinKey, ObjectId, Timestamp, UUID,
  type AggregationCursor, type Collection, type Db, type Document, type FindCursor, type MongoClient,
} from 'mongodb';
import { docToWire, FIDELITY_READ, bsonToWire } from '../core/bsonCodec';
import { wireToCopyText, wireToShell } from '../shared/wire';
import type { PlaygroundBlock } from '../shared/protocol';
import { ScriptSyntaxError, transformScript } from './transform';

export class ReadOnlyViolation extends Error {
  constructor(method: string) {
    super(`${method}() is blocked because this connection is read-only.`);
    this.name = 'ReadOnlyError';
  }
}

const WRITE_METHODS = new Set([
  'insert', 'insertOne', 'insertMany', 'update', 'updateOne', 'updateMany', 'replaceOne', 'remove', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'findAndModify', 'bulkWrite', 'drop', 'rename',
  'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes',
]);

const READ_COMMANDS = new Set([
  'ping', 'buildinfo', 'hello', 'ismaster', 'serverstatus', 'dbstats', 'collstats', 'listcollections', 'listindexes', 'find',
  'count', 'distinct', 'explain', 'connectionstatus', 'getcmdlineopts', 'hostinfo', 'top', 'currentop', 'listdatabases',
]);

function isWritePipeline(pipeline: unknown): boolean {
  return Array.isArray(pipeline) && pipeline.some((s) => s && typeof s === 'object' && ('$out' in s || '$merge' in s));
}

export interface RuntimeOptions {
  client: MongoClient;
  database: string;
  readOnly: boolean;
  resultLimit: number;
  filename: string;
  emit: (block: Omit<PlaygroundBlock, 'id'>) => void;
}

/** Adds mongosh cursor helpers to a driver cursor. */
function enhanceCursor<T extends FindCursor<Document> | AggregationCursor<Document>>(cursor: T): T {
  const c = cursor as unknown as Record<string, unknown>;
  c.pretty = () => cursor;
  c.itcount = async () => (await cursor.toArray()).length;
  c.size = async () => (await cursor.toArray()).length;
  c.__isCursor = true;
  return cursor;
}

function wrapCollection(coll: Collection, opts: RuntimeOptions, track: <P>(p: P) => P): Collection {
  const guard = (name: string) => {
    if (opts.readOnly && WRITE_METHODS.has(name)) throw new ReadOnlyViolation(name);
  };
  const extras: Record<string, unknown> = {
    find: (filter: Document = {}, projection?: Document, options?: Document) =>
      enhanceCursor(coll.find(filter, { ...FIDELITY_READ, ...(projection ? { projection } : {}), ...options })),
    findOne: (filter: Document = {}, projection?: Document, options?: Document) =>
      track(coll.findOne(filter, { ...FIDELITY_READ, ...(projection ? { projection } : {}), ...options })),
    aggregate: (...args: unknown[]) => {
      const pipeline = Array.isArray(args[0]) ? (args[0] as Document[]) : (args.filter((a) => a && typeof a === 'object') as Document[]);
      const options = Array.isArray(args[0]) ? (args[1] as Document | undefined) : undefined;
      if (opts.readOnly && isWritePipeline(pipeline)) throw new ReadOnlyViolation('aggregate with $out/$merge');
      return enhanceCursor(coll.aggregate(pipeline, { ...FIDELITY_READ, ...options }));
    },
    count: (filter: Document = {}) => track(coll.countDocuments(filter)),
    getIndexes: () => track(coll.listIndexes().toArray()),
    getName: () => coll.collectionName,
    stats: () => track(coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray().then((r) => r[0]?.storageStats)),
    explain: (verbosity = 'queryPlanner') => ({
      find: (f: Document = {}) => track(coll.find(f).explain(verbosity as 'queryPlanner')),
      aggregate: (p: Document[] = []) => track(coll.aggregate(p).explain(verbosity as 'queryPlanner')),
    }),
  };
  return new Proxy(coll, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      guard(prop);
      if (prop in extras) return extras[prop];
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const r = (value as (...a: unknown[]) => unknown).apply(target, args);
        return r instanceof Promise ? track(r) : r;
      };
    },
  });
}

function createDb(database: Db, opts: RuntimeOptions, track: <P>(p: P) => P, setCurrent: (name: string) => void): Db {
  const helpers: Record<string, unknown> = {
    getName: () => database.databaseName,
    getCollection: (name: string) => wrapCollection(database.collection(name), opts, track),
    getCollectionNames: () => track(database.listCollections({}, { nameOnly: true }).toArray().then((r) => r.map((c) => c.name).sort())),
    getCollectionInfos: (filter: Document = {}) => track(database.listCollections(filter).toArray()),
    getSiblingDB: (name: string) => createDb(database.client.db(name), opts, track, setCurrent),
    getMongo: () => ({ getDBNames: () => track(database.admin().listDatabases().then((r) => r.databases.map((d) => d.name))) }),
    stats: () => track(database.stats()),
    version: () => track(database.admin().serverInfo().then((i) => i.version)),
    runCommand: (cmd: Document) => {
      const name = String(Object.keys(cmd)[0]).toLowerCase();
      if (opts.readOnly && !READ_COMMANDS.has(name)) throw new ReadOnlyViolation(`runCommand ${name}`);
      return track(database.command(cmd));
    },
    adminCommand: (cmd: Document) => {
      const name = String(Object.keys(cmd)[0]).toLowerCase();
      if (opts.readOnly && !READ_COMMANDS.has(name)) throw new ReadOnlyViolation(`adminCommand ${name}`);
      return track(database.admin().command(cmd));
    },
    aggregate: (pipeline: Document[], options?: Document) => {
      if (opts.readOnly && isWritePipeline(pipeline)) throw new ReadOnlyViolation('aggregate with $out/$merge');
      return enhanceCursor(database.aggregate(pipeline, { ...FIDELITY_READ, ...options }));
    },
    createCollection: (name: string, options?: Document) => {
      if (opts.readOnly) throw new ReadOnlyViolation('createCollection');
      return track(database.createCollection(name, options).then(() => ({ ok: 1 })));
    },
    createView: (name: string, source: string, pipeline: Document[]) => {
      if (opts.readOnly) throw new ReadOnlyViolation('createView');
      return track(database.createCollection(name, { viewOn: source, pipeline }).then(() => ({ ok: 1 })));
    },
    dropDatabase: () => {
      if (opts.readOnly) throw new ReadOnlyViolation('dropDatabase');
      return track(database.dropDatabase().then((dropped) => ({ dropped: database.databaseName, ok: dropped ? 1 : 0 })));
    },
  };
  return new Proxy({} as Db, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in helpers) return helpers[prop];
      if (prop === 'then' || prop === '__isCursor' || prop === 'toJSON') return undefined;
      return wrapCollection(database.collection(prop), opts, track);
    },
    ownKeys() { return []; },
    has() { return true; },
  });
}

function isCursor(v: unknown): v is FindCursor<Document> {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>).__isCursor === true;
}

function formatPrint(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : wireToShell(bsonToWire(a), true))).join(' ');
}

/** Runs a script to completion, emitting result blocks as they appear. */
export async function runScript(code: string, opts: RuntimeOptions): Promise<void> {
  const pending = new Set<Promise<unknown>>();
  const track = <P,>(p: P): P => {
    if (p instanceof Promise) {
      const tracked = p.catch(() => undefined).finally(() => pending.delete(tracked));
      pending.add(tracked);
    }
    return p;
  };

  let current = opts.database;
  const setCurrent = (name: string) => { current = name; };
  const currentDb = () => createDb(opts.client.db(current), opts, track, setCurrent);
  let db = currentDb();

  const print = (...args: unknown[]): void => { opts.emit({ kind: 'print', text: formatPrint(args) }); };
  const toDate = (v?: string | number) => (v === undefined ? new Date() : new Date(v));

  const show = async (line: number, label: string, value: unknown) => {
    const start = performance.now();
    let v = value;
    if (isCursor(v)) {
      // Iterate rather than change the cursor's limit, so the script's own .limit() is respected.
      const cursor = v as FindCursor<Document>;
      const list: Document[] = [];
      while (list.length <= opts.resultLimit && (await cursor.hasNext())) {
        const next = await cursor.next();
        if (next) list.push(next);
      }
      const truncated = list.length > opts.resultLimit;
      await cursor.close().catch(() => undefined);
      opts.emit({
        kind: 'result', line, label, docs: (truncated ? list.slice(0, opts.resultLimit) : list).map(docToWire), truncated,
        ms: Math.round(performance.now() - start),
      });
      return;
    }
    if (Array.isArray(v) && v.some((x) => x instanceof Promise || Object.prototype.toString.call(x) === '[object Promise]')) v = await Promise.all(v);
    if (v === undefined) return;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && Object.prototype.toString.call(x) === '[object Object]')) {
      const list = v as Document[];
      const truncated = list.length > opts.resultLimit;
      opts.emit({ kind: 'result', line, label, docs: (truncated ? list.slice(0, opts.resultLimit) : list).map(docToWire), truncated });
      return;
    }
    opts.emit({ kind: 'result', line, label, value: bsonToWire(v) });
  };

  const sandbox: Record<string, unknown> = {
    get db() { return db; },
    set db(v) { db = v as typeof db; },
    use: (name: string) => {
      current = String(name);
      db = currentDb();
      opts.emit({ kind: 'print', text: `switched to db ${current}` });
    },
    __quietUse: (name: string) => {
      current = String(name);
      db = currentDb();
    },
    print,
    printjson: print,
    console: { log: print, info: print, warn: print, error: print, debug: print },
    __show: show,
    __showCmd: async (what: string) => {
      if (what === 'dbs' || what === 'databases') {
        const r = await opts.client.db().admin().listDatabases({ nameOnly: false });
        opts.emit({ kind: 'print', text: r.databases.map((d) => d.name).join('\n') });
      } else {
        const r = await opts.client.db(current).listCollections({}, { nameOnly: true }).toArray();
        opts.emit({ kind: 'print', text: r.map((c) => c.name).sort().join('\n') });
      }
    },
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    ObjectId: (v?: string) => new ObjectId(v),
    ObjectID: (v?: string) => new ObjectId(v),
    ISODate: toDate,
    NumberInt: (v: number | string) => new Int32(Number(v)),
    NumberLong: (v: number | string) => (typeof v === 'string' ? Long.fromString(v) : Long.fromNumber(v)),
    NumberDecimal: (v: string | number) => Decimal128.fromString(String(v)),
    Decimal128: (v: string | number) => Decimal128.fromString(String(v)),
    Long: (v: number | string) => (typeof v === 'string' ? Long.fromString(v) : Long.fromNumber(v)),
    Int32: (v: number) => new Int32(v),
    Double: (v: number) => new Double(v),
    UUID: (v?: string) => (v ? new UUID(v) : new UUID()),
    BinData: (sub: number, b64: string) => Binary.createFromBase64(b64, sub),
    Binary,
    Timestamp: (a?: { t: number; i: number }) => new Timestamp(a ?? { t: 0, i: 0 }),
    MinKey: () => new MinKey(),
    MaxKey: () => new MaxKey(),
    BSONRegExp, BSONSymbol, Code, DBRef,
    setTimeout,
  };
  vm.createContext(sandbox);

  const transformed = transformScript(code);
  // The wrapper stays on the first line of the script, so line numbers match the editor.
  const script = new vm.Script(`(async () => {${transformed}\n})()`, { filename: opts.filename });
  await script.runInContext(sandbox);
  await Promise.allSettled([...pending]);
}

/** Line number from an error, as reported for the user's script. */
export function errorLine(err: unknown, filename: string): number | undefined {
  if (err instanceof ScriptSyntaxError) return err.line;
  const stack = (err as Error)?.stack ?? '';
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = stack.match(new RegExp(`${escaped}:(\\d+):\\d+`));
  return m ? Number(m[1]) : undefined;
}

export { wireToCopyText };
