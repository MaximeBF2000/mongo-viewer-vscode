// Streaming import, export and copy. Documents pass through in batches, so memory
// use stays flat regardless of collection size.
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Collection, Document, FindCursor } from 'mongodb';
import { bsonToWire, EJSON, parseImportText } from './bsonCodec';
import { flattenWire, wireToCsvCell } from '../shared/wire';

export interface Progress { (done: number): void }

export interface TransferOptions { onProgress?: Progress; signal?: AbortSignal }

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error('Cancelled');
    e.name = 'AbortError';
    throw e;
  }
}

async function writeLine(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain');
}

async function endStream(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.end(() => resolve());
  });
}

export async function exportJson(docs: AsyncIterable<Document>, path: string, opts: TransferOptions = {}): Promise<number> {
  const out = createWriteStream(path, 'utf8');
  let n = 0;
  await writeLine(out, '[');
  for await (const doc of docs) {
    checkAbort(opts.signal);
    await writeLine(out, `${n ? ',' : ''}\n  ${EJSON.stringify(doc, { relaxed: true })}`);
    n++;
    if (n % 500 === 0) opts.onProgress?.(n);
  }
  await writeLine(out, n ? '\n]\n' : ']\n');
  await endStream(out);
  opts.onProgress?.(n);
  return n;
}

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Writes CSV in two passes through a temp file: columns are only fully known after
 * the last document, and rows must not pile up in memory until then.
 */
export async function exportCsv(docs: AsyncIterable<Document>, path: string, opts: TransferOptions = {}): Promise<number> {
  const tempPath = join(tmpdir(), `mongo-viewer-${process.pid}-${Date.now()}.tmp`);
  const temp = createWriteStream(tempPath, 'utf8');
  const columns = new Map<string, number>();
  let n = 0;
  try {
    for await (const doc of docs) {
      checkAbort(opts.signal);
      const row: Record<number, string> = {};
      for (const [p, v] of flattenWire(bsonToWire(doc))) {
        let idx = columns.get(p);
        if (idx === undefined) {
          idx = columns.size;
          columns.set(p, idx);
        }
        row[idx] = wireToCsvCell(v);
      }
      await writeLine(temp, JSON.stringify(row) + '\n');
      n++;
      if (n % 500 === 0) opts.onProgress?.(n);
    }
    await endStream(temp);
    const out = createWriteStream(path, 'utf8');
    const headers = [...columns.keys()];
    await writeLine(out, headers.map(csvEscape).join(',') + '\n');
    const lines = createInterface({ input: createReadStream(tempPath, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      checkAbort(opts.signal);
      const row = JSON.parse(line) as Record<string, string>;
      await writeLine(out, headers.map((_, i) => csvEscape(row[i] ?? '')).join(',') + '\n');
    }
    await endStream(out);
  } finally {
    temp.destroy();
    await fs.rm(tempPath, { force: true });
  }
  opts.onProgress?.(n);
  return n;
}

export interface ImportResult { inserted: number; failed: number; firstError?: string }

const BATCH = 1000;

async function insertBatch(coll: Collection, batch: Document[], res: ImportResult): Promise<void> {
  try {
    const r = await coll.insertMany(batch, { ordered: false });
    res.inserted += r.insertedCount;
  } catch (err) {
    const e = err as Error & { insertedCount?: number; result?: { insertedCount?: number } };
    const inserted = e.insertedCount ?? e.result?.insertedCount ?? 0;
    res.inserted += inserted;
    res.failed += batch.length - inserted;
    res.firstError ??= e.message;
  }
}

/** Imports a JSON array, a single document, or newline-delimited JSON. */
export async function importFile(coll: Collection, path: string, opts: TransferOptions = {}): Promise<ImportResult> {
  const res: ImportResult = { inserted: 0, failed: 0 };
  const head = await readHead(path);
  const firstChar = head.trimStart()[0];
  if (firstChar !== '[' && firstChar !== '{') throw new Error('This file does not look like JSON. It should start with [ or {.');

  // NDJSON can stream line by line. Anything else must be parsed whole.
  const isNdjson = firstChar === '{' && /\}\s*\r?\n\s*\{/.test(head);
  let batch: Document[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await insertBatch(coll, batch, res);
    batch = [];
    opts.onProgress?.(res.inserted + res.failed);
  };
  if (isNdjson) {
    let lineNo = 0;
    const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNo++;
      checkAbort(opts.signal);
      if (!line.trim()) continue;
      try {
        batch.push(EJSON.parse(line, { relaxed: true }) as Document);
      } catch (err) {
        throw new Error(`Line ${lineNo}: ${(err as Error).message}. ${res.inserted} documents were imported before this line.`);
      }
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    return res;
  }
  const docs = parseImportText(await fs.readFile(path, 'utf8'));
  for (let i = 0; i < docs.length; i += BATCH) {
    checkAbort(opts.signal);
    batch = docs.slice(i, i + BATCH);
    await flush();
  }
  return res;
}

async function readHead(path: string): Promise<string> {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Copies documents in batches, then recreates secondary indexes. */
export async function copyCollection(
  source: Collection,
  target: Collection,
  opts: TransferOptions & { copyIndexes?: boolean } = {},
): Promise<ImportResult> {
  const res: ImportResult = { inserted: 0, failed: 0 };
  const cursor: FindCursor<Document> = source.find({}, { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true, batchSize: BATCH });
  let batch: Document[] = [];
  for await (const doc of cursor) {
    checkAbort(opts.signal);
    batch.push(doc);
    if (batch.length >= BATCH) {
      await insertBatch(target, batch, res);
      batch = [];
      opts.onProgress?.(res.inserted + res.failed);
    }
  }
  if (batch.length) await insertBatch(target, batch, res);
  opts.onProgress?.(res.inserted + res.failed);
  if (opts.copyIndexes !== false) {
    const indexes = (await source.listIndexes().toArray()) as Document[];
    for (const ix of indexes) {
      if (ix.name === '_id_') continue;
      const { key, v: _v, ns: _ns, ...options } = ix;
      await target.createIndex(key, options);
    }
  }
  return res;
}
