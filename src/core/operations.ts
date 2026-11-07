// Database operations for the collection viewer. No VS Code imports, so all of
// this is tested directly against a real MongoDB server.
import type { Collection, Db, Document, MongoClient, Sort } from 'mongodb';
import { bsonToWire, decodeId, docToWire, FIDELITY_READ, parseEditableValue, parseQueryDocument, parsePipeline } from './bsonCodec';
import { analyzeSchema } from './schema';
import { wireToShell } from '../shared/wire';
import { ShellSyntaxError } from '../shared/shell';
import type {
  AggregationStage, AggregateResult, CountResult, CreateIndexInput, ExplainSummary, FindRequest, FindResult, IndexInfo,
  PlanStage, QueryInput, RpcError, SchemaResult, StatsResult,
} from '../shared/protocol';

export class FieldError extends Error {
  constructor(readonly field: NonNullable<RpcError['field']>, readonly inner: Error, readonly stage?: number) {
    super(inner.message);
  }
}

function parseField(text: string | undefined, field: 'filter' | 'sort' | 'project'): Document | undefined {
  try {
    return parseQueryDocument(text);
  } catch (err) {
    throw new FieldError(field, err as Error);
  }
}

export interface ParsedQuery {
  filter: Document;
  sort?: Sort;
  projection?: Document;
  limit?: number;
}

export function parseQuery(q: Partial<QueryInput>): ParsedQuery {
  const filter = parseField(q.filter, 'filter') ?? {};
  const sort = parseField(q.sort, 'sort') as Sort | undefined;
  const projection = parseField(q.project, 'project');
  let limit: number | undefined;
  const rawLimit = q.limit?.trim();
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 0) throw new FieldError('limit', new Error('Limit must be a whole number, or empty for no limit.'));
    if (limit === 0) limit = undefined;
  }
  return { filter, sort, projection, limit };
}

export function hasValue(d: Document | undefined): boolean {
  return !!d && Object.keys(d).length > 0;
}

export async function findPage(coll: Collection, req: FindRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<FindResult> {
  const q = parseQuery(req);
  const pageSize = Math.max(1, Math.min(req.pageSize, 1000));
  const page = Math.max(0, req.page);
  const skip = page * pageSize;
  // One extra document tells us whether there is a next page without a count.
  let take = pageSize + 1;
  if (q.limit !== undefined) take = Math.min(take, Math.max(0, q.limit - skip));
  const start = performance.now();
  if (take === 0) return { docs: [], hasMore: false, ms: 0, page, pageSize };
  const cursor = coll.find(q.filter, {
    ...FIDELITY_READ,
    projection: hasValue(q.projection) ? q.projection : undefined,
    sort: q.sort,
    skip,
    limit: take,
    maxTimeMS: opts.timeoutMs,
    signal: opts.signal,
  });
  try {
    const docs = await cursor.toArray();
    const ms = Math.round(performance.now() - start);
    const hasMore = docs.length > pageSize;
    const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;
    return { docs: pageDocs.map(docToWire), hasMore, ms, page, pageSize };
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

export async function countQuery(coll: Collection, filterText: string, type: string, timeoutMs: number): Promise<CountResult> {
  const filter = parseField(filterText, 'filter') ?? {};
  try {
    if (!hasValue(filter) && type === 'collection') {
      return { count: await coll.estimatedDocumentCount({ maxTimeMS: timeoutMs }), exact: false };
    }
    return { count: await coll.countDocuments(filter, { maxTimeMS: timeoutMs }), exact: true };
  } catch (err) {
    if ((err as { code?: number }).code === 50) return { count: null, exact: false, timedOut: true };
    throw err;
  }
}

export async function sampleSchema(coll: Collection, sampleSize: number, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SchemaResult> {
  const start = performance.now();
  const docs = await coll
    .aggregate([{ $sample: { size: sampleSize } }], { ...FIDELITY_READ, maxTimeMS: opts.timeoutMs, signal: opts.signal, allowDiskUse: false })
    .toArray();
  return { ...analyzeSchema(docs), ms: Math.round(performance.now() - start) };
}

function describeKey(v: unknown): string {
  if (typeof v === 'number') return v > 0 ? 'ascending' : 'descending';
  const n = Number(v);
  if (!Number.isNaN(n) && typeof v !== 'string') return n > 0 ? 'ascending' : 'descending';
  return String(v);
}

export async function listIndexes(coll: Collection): Promise<IndexInfo[]> {
  const raw = (await coll.listIndexes().toArray()) as Document[];
  const usage = new Map<string, { ops: number; since?: string }>();
  let sizes: Record<string, number> = {};
  try {
    const stats = await coll.aggregate([{ $indexStats: {} }], { maxTimeMS: 3000 }).toArray();
    for (const s of stats) usage.set(s.name, { ops: Number(s.accesses?.ops ?? 0), since: s.accesses?.since?.toISOString?.() });
  } catch { /* $indexStats needs a privilege that restricted users may not have */ }
  try {
    const [s] = await coll.aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 3000 }).toArray();
    sizes = s?.storageStats?.indexSizes ?? {};
  } catch { /* same as above */ }
  return raw.map((ix): IndexInfo => {
    const keys = Object.entries(ix.key as Document).map(([field, v]) => ({ field, direction: describeKey(v) }));
    const special = keys.map((k) => k.direction).find((d) => d !== 'ascending' && d !== 'descending');
    const kind = special ? special : keys.length > 1 ? 'compound' : 'single field';
    return {
      name: ix.name,
      keyText: wireToShell(bsonToWire(ix.key), false),
      keys,
      kind: ix.name === '_id_' ? 'default' : ix.textIndexVersion ? 'text' : kind,
      unique: !!ix.unique || ix.name === '_id_',
      sparse: !!ix.sparse,
      hidden: !!ix.hidden,
      ttlSeconds: ix.expireAfterSeconds,
      partialText: ix.partialFilterExpression ? wireToShell(bsonToWire(ix.partialFilterExpression), false) : undefined,
      sizeBytes: sizes[ix.name],
      ops: usage.get(ix.name)?.ops,
      since: usage.get(ix.name)?.since,
      isDefault: ix.name === '_id_',
    };
  });
}

export async function createIndex(coll: Collection, input: CreateIndexInput): Promise<string> {
  let keys: Document | undefined;
  try {
    keys = parseQueryDocument(input.keys);
  } catch (err) {
    throw new FieldError('keys', err as Error);
  }
  if (!hasValue(keys)) throw new FieldError('keys', new Error('Enter the fields to index, such as { email: 1 }.'));
  const options: Document = {};
  if (input.name.trim()) options.name = input.name.trim();
  if (input.unique) options.unique = true;
  if (input.sparse) options.sparse = true;
  if (input.hidden) options.hidden = true;
  if (input.ttlSeconds.trim()) {
    const ttl = Number(input.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 0) throw new FieldError('keys', new Error('TTL must be a whole number of seconds.'));
    options.expireAfterSeconds = ttl;
  }
  if (input.partial.trim()) {
    try {
      options.partialFilterExpression = parseQueryDocument(input.partial);
    } catch (err) {
      throw new FieldError('partial', err as Error);
    }
  }
  return coll.createIndex(keys as Document, options);
}

export async function collectionStats(db: Db, name: string, typeHint: string): Promise<StatsResult> {
  const [info] = (await db.listCollections({ name }).toArray()) as Document[];
  const type = info?.type ?? typeHint;
  const result: StatsResult = {
    count: null, storageSize: null, size: null, avgObjSize: null, totalIndexSize: null, nindexes: null,
    capped: !!info?.options?.capped, type,
    viewOn: info?.options?.viewOn,
    pipelineText: info?.options?.pipeline ? wireToShell(bsonToWire(info.options.pipeline), true) : undefined,
    validatorText: info?.options?.validator ? wireToShell(bsonToWire(info.options.validator), true) : undefined,
  };
  if (type === 'view') return result;
  try {
    const [s] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 5000 }).toArray();
    const st = s?.storageStats;
    if (st) {
      result.count = st.count ?? null;
      result.storageSize = st.storageSize ?? null;
      result.size = st.size ?? null;
      result.avgObjSize = st.avgObjSize ?? null;
      result.totalIndexSize = st.totalIndexSize ?? null;
      result.nindexes = st.nindexes ?? null;
    }
  } catch {
    result.count = await db.collection(name).estimatedDocumentCount().catch(() => null);
  }
  return result;
}

function walkPlan(node: Document | undefined): PlanStage | null {
  if (!node) return null;
  const childNodes: Document[] = [];
  if (node.inputStage) childNodes.push(node.inputStage);
  if (Array.isArray(node.inputStages)) childNodes.push(...node.inputStages);
  if (node.queryPlan) childNodes.push(node.queryPlan);
  const stage = String(node.stage ?? node.isCached ?? 'STAGE');
  let detail: string | undefined;
  if (node.indexName) detail = `${node.indexName} ${node.keyPattern ? wireToShell(bsonToWire(node.keyPattern), false) : ''}`.trim();
  else if (node.filter) detail = wireToShell(bsonToWire(node.filter), false);
  else if (node.sortPattern) detail = wireToShell(bsonToWire(node.sortPattern), false);
  return {
    stage,
    detail,
    docs: typeof node.nReturned === 'number' ? node.nReturned : undefined,
    keys: typeof node.keysExamined === 'number' ? node.keysExamined : undefined,
    ms: typeof node.executionTimeMillisEstimate === 'number' ? node.executionTimeMillisEstimate : undefined,
    children: childNodes.map(walkPlan).filter((x): x is PlanStage => !!x),
  };
}

function collectStages(s: PlanStage | null, out: PlanStage[] = []): PlanStage[] {
  if (!s) return out;
  out.push(s);
  s.children.forEach((c) => collectStages(c, out));
  return out;
}

function filterFields(filter: Document, out: string[] = []): string[] {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') {
      if (Array.isArray(v)) v.forEach((x) => filterFields(x as Document, out));
    } else if (!k.startsWith('$')) {
      out.push(k);
    }
  }
  return [...new Set(out)];
}

/** ESR guideline: equality fields, then sort fields, then range fields. */
export function suggestIndex(filter: Document, sort: Document | undefined): string | undefined {
  const equality: string[] = [];
  const range: string[] = [];
  for (const k of filterFields(filter)) {
    const v = filter[k];
    const isRange = v && typeof v === 'object' && Object.keys(v).some((op) => ['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$regex', '$exists'].includes(op));
    (isRange ? range : equality).push(k);
  }
  const sortEntries = sort ? Object.entries(sort) : [];
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (field: string, dir: number) => {
    if (seen.has(field) || field === '_id') return;
    seen.add(field);
    parts.push(`${/^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)}: ${dir}`);
  };
  equality.forEach((f) => add(f, 1));
  sortEntries.forEach(([f, d]) => add(f, Number(d) < 0 ? -1 : 1));
  range.forEach((f) => add(f, 1));
  return parts.length ? `{ ${parts.join(', ')} }` : undefined;
}

export function summarizeExplain(plan: Document, filter: Document, sort: Document | undefined): ExplainSummary {
  const stats = plan.executionStats as Document | undefined;
  const winning = stats?.executionStages ?? plan.queryPlanner?.winningPlan;
  const queryPlan = plan.queryPlanner?.winningPlan?.queryPlan;
  const stages = walkPlan(winning) ?? walkPlan(queryPlan);
  const all = collectStages(stages);
  const collectionScan = all.some((s) => s.stage === 'COLLSCAN');
  const indexes = [...new Set(all.filter((s) => s.stage === 'IXSCAN' || s.stage === 'EXPRESS_IXSCAN').map((s) => s.detail?.split(' ')[0] ?? ''))].filter(Boolean);
  const sortInMemory = all.some((s) => s.stage === 'SORT');
  const docsExamined: number | null = stats?.totalDocsExamined ?? null;
  const keysExamined: number | null = stats?.totalKeysExamined ?? null;
  const returned: number | null = stats?.nReturned ?? null;
  const tips: ExplainSummary['tips'] = [];
  const suggestKeys = suggestIndex(filter, sort);
  if (collectionScan && hasValue(filter)) {
    tips.push({ text: 'This query scans the whole collection. An index on the filtered fields could make it much faster.', suggestKeys });
  } else if (collectionScan && hasValue(sort)) {
    tips.push({ text: 'This sort reads the whole collection. An index on the sort fields would avoid that.', suggestKeys });
  }
  if (sortInMemory && !collectionScan) {
    tips.push({ text: 'Results are sorted in memory. An index that includes the sort fields would avoid this.', suggestKeys });
  }
  if (docsExamined !== null && returned !== null && returned > 0 && docsExamined / returned > 100 && !collectionScan) {
    tips.push({ text: `The server read ${Math.round(docsExamined / returned)} documents for each one returned. A more selective index would help.`, suggestKeys });
  }
  return {
    ms: stats?.executionTimeMillis ?? null,
    docsExamined,
    keysExamined,
    returned,
    collectionScan,
    indexes,
    stages,
    rejectedPlans: plan.queryPlanner?.rejectedPlans?.length ?? 0,
    sortInMemory,
    tips,
    raw: wireToShell(bsonToWire(plan), true),
  };
}

export async function explainQuery(coll: Collection, q: QueryInput, opts: { timeoutMs: number }): Promise<ExplainSummary> {
  const parsed = parseQuery(q);
  const cursor = coll.find(parsed.filter, {
    projection: hasValue(parsed.projection) ? parsed.projection : undefined,
    sort: parsed.sort,
    limit: parsed.limit,
    maxTimeMS: opts.timeoutMs,
  });
  const plan = await cursor.explain('executionStats');
  return summarizeExplain(plan, parsed.filter, parsed.sort as Document | undefined);
}

export function buildPipeline(stages: AggregationStage[]): Document[] {
  const out: Document[] = [];
  stages.forEach((s, i) => {
    if (!s.enabled || !s.op) return;
    try {
      const body = parseEditableValueForStage(s.body);
      out.push({ [s.op]: body });
    } catch (err) {
      throw new FieldError('pipeline', err as Error, i);
    }
  });
  return out;
}

function parseEditableValueForStage(body: string): unknown {
  if (!body.trim()) return {};
  // `$project: { a: 1 }`, `$limit: 5`, `$unwind: "$tags"` and `$count: "n"` are all valid.
  const wrapped = parsePipeline(`[${body}]`);
  return wrapped[0];
}

const WRITE_STAGES = new Set(['$out', '$merge']);

export function isWritePipeline(p: Document[]): boolean {
  return p.some((s) => Object.keys(s).some((k) => WRITE_STAGES.has(k)));
}

export async function aggregatePreview(
  coll: Collection,
  stages: AggregationStage[],
  limit: number,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<AggregateResult> {
  const pipeline = buildPipeline(stages).filter((s) => !WRITE_STAGES.has(Object.keys(s)[0]));
  const start = performance.now();
  const docs = await coll
    .aggregate([...pipeline, { $limit: limit + 1 }], { ...FIDELITY_READ, maxTimeMS: opts.timeoutMs, signal: opts.signal })
    .toArray();
  const truncated = docs.length > limit;
  return { docs: (truncated ? docs.slice(0, limit) : docs).map(docToWire), ms: Math.round(performance.now() - start), truncated };
}

export function idsToFilter(ids: string[]): Document {
  return { _id: { $in: ids.map(decodeId) } };
}

/** Builds the dotted path for a field update, or fails if it cannot be expressed safely. */
export function fieldPath(path: string[]): string {
  if (path.length === 0) throw new Error('No field selected.');
  for (const seg of path) {
    if (seg.includes('.') || seg.startsWith('$')) {
      throw new Error(`The field "${seg}" contains characters that can't be edited inline. Open the document to change it.`);
    }
  }
  if (path[0] === '_id') throw new Error('The _id field cannot be changed.');
  return path.join('.');
}

export async function updateField(coll: Collection, id: string, path: string[], valueText: string): Promise<void> {
  const p = fieldPath(path);
  let value: unknown;
  try {
    value = parseEditableValue(valueText);
  } catch (err) {
    throw new FieldError('value', err as Error);
  }
  const res = await coll.updateOne({ _id: decodeId(id) } as Document, { $set: { [p]: value } });
  if (res.matchedCount === 0) throw new Error('This document no longer exists.');
}

export async function removeField(coll: Collection, id: string, path: string[]): Promise<void> {
  const p = fieldPath(path);
  const res = await coll.updateOne({ _id: decodeId(id) } as Document, { $unset: { [p]: '' } });
  if (res.matchedCount === 0) throw new Error('This document no longer exists.');
}

export function parseUpdate(text: string): Document | Document[] {
  let parsed: Document | Document[] | undefined;
  try {
    parsed = text.trimStart().startsWith('[') ? parsePipeline(text) : parseQueryDocument(text);
  } catch (err) {
    if (err instanceof ShellSyntaxError) throw new FieldError('update', err);
    throw err;
  }
  if (!parsed || (Array.isArray(parsed) ? parsed.length === 0 : Object.keys(parsed).length === 0)) {
    throw new FieldError('update', new Error('Enter an update, such as { $set: { active: true } }.'));
  }
  if (!Array.isArray(parsed) && !Object.keys(parsed).every((k) => k.startsWith('$'))) {
    throw new FieldError('update', new Error('An update must use operators such as $set or $unset.'));
  }
  return parsed;
}

export function classifyListCollections(info: Document): string {
  return info.type ?? 'collection';
}

export function queryToScript(collection: string, q: QueryInput): string {
  const coll = /^[A-Za-z_$][\w$]*$/.test(collection) && !['getCollection', 'runCommand'].includes(collection)
    ? `db.${collection}`
    : `db.getCollection(${JSON.stringify(collection)})`;
  const filter = q.filter.trim() || '{}';
  let line = `${coll}.find(${filter}${q.project.trim() ? `, ${q.project.trim()}` : ''})`;
  if (q.sort.trim()) line += `.sort(${q.sort.trim()})`;
  if (q.limit.trim()) line += `.limit(${q.limit.trim()})`;
  return line;
}

export function pipelineToScript(collection: string, stages: AggregationStage[]): string {
  const coll = /^[A-Za-z_$][\w$]*$/.test(collection) ? `db.${collection}` : `db.getCollection(${JSON.stringify(collection)})`;
  const lines = stages.filter((s) => s.enabled && s.op).map((s) => `  { ${s.op}: ${s.body.trim() || '{}'} }`);
  return `${coll}.aggregate([\n${lines.join(',\n')}\n])`;
}

export type { MongoClient };
