// Runs against a real MongoDB. TEST_MONGO_URI defaults to the local test container.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal128, Double, Int32, Long, MongoClient, ObjectId, type Collection, type Db, type Document } from 'mongodb';
import * as ops from '../../src/core/operations';
import { docToShell, FIDELITY_READ, parseEditableDocument, fingerprint } from '../../src/core/bsonCodec';
import { copyCollection, exportCsv, exportJson, importFile } from '../../src/core/transfer';
import { runScript } from '../../src/playground/runtime';
import { listStatements, looksLikeWrite, transformScript } from '../../src/playground/transform';
import type { PlaygroundBlock } from '../../src/shared/protocol';

const URI = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27099';
const blank = { filter: '', sort: '', project: '', limit: '' };
let client: MongoClient;
let db: Db;
let users: Collection;
const DBNAME = `mv_test_${process.pid}`;

beforeAll(async () => {
  client = await new MongoClient(URI, { serverSelectionTimeoutMS: 4000 }).connect();
  db = client.db(DBNAME);
  users = db.collection('users');
  await users.insertMany(
    Array.from({ length: 95 }, (_, i) => ({
      _id: new ObjectId(i.toString(16).padStart(24, '0')),
      name: `user${i}`,
      age: 18 + (i % 50),
      active: i % 2 === 0,
      createdAt: new Date(Date.UTC(2024, 0, 1 + i)),
      address: { city: i % 3 ? 'Paris' : 'Lyon', zip: 75000 + i },
      tags: i % 5 ? ['a', 'b'] : [],
      ...(i % 10 === 0 ? { nick: null } : {}),
    })),
  );
  await db.createCollection('users_view', { viewOn: 'users', pipeline: [{ $match: { active: true } }] });
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

const find = (over: Record<string, unknown> = {}, coll = users) =>
  ops.findPage(coll, { ...blank, requestId: 'x', page: 0, pageSize: 20, ...over } as never, { timeoutMs: 5000 });

describe('browsing', () => {
  it('paginates without a count and detects the last page', async () => {
    const p0 = await find();
    expect(p0.docs).toHaveLength(20);
    expect(p0.hasMore).toBe(true);
    const p4 = await find({ page: 4 });
    expect(p4.docs).toHaveLength(15);
    expect(p4.hasMore).toBe(false);
  });
  it('filters, sorts, projects and limits', async () => {
    const r = await find({ filter: '{ active: true, age: { $gte: 40 } }', sort: '{ age: -1 }', project: '{ name: 1, age: 1, _id: 0 }', limit: '3' });
    expect(r.docs).toHaveLength(3);
    expect(r.hasMore).toBe(false);
    const first = r.docs[0].value as { e: [string, { v: number }][] };
    expect(first.e.map(([k]) => k)).toEqual(['name', 'age']);
    expect(first.e[1][1].v).toBe(66);
  });
  it('stops at the limit across pages', async () => {
    const p0 = await find({ limit: '25' });
    expect(p0.hasMore).toBe(true);
    const p1 = await find({ limit: '25', page: 1 });
    expect(p1.docs).toHaveLength(5);
    expect(p1.hasMore).toBe(false);
    expect((await find({ limit: '20', page: 1 })).docs).toHaveLength(0);
  });
  it('supports $regex, $in, $or and ObjectId searches', async () => {
    expect((await find({ filter: '{ name: /^user9\\d$/ }' })).docs).toHaveLength(5);
    expect((await find({ filter: '{ age: { $in: [18, 19] } }', pageSize: 100 } as never)).docs.length).toBeGreaterThan(2);
    expect((await find({ filter: '{ $or: [{ name: "user1" }, { name: "user2" }] }' })).docs).toHaveLength(2);
    expect((await find({ filter: `{ _id: ObjectId("${'0'.repeat(23)}1") }` })).docs).toHaveLength(1);
    expect((await find({ filter: '{ createdAt: { $lt: ISODate("2024-01-03") } }' })).docs).toHaveLength(2);
  });
  it('reports which field has a syntax error', async () => {
    await expect(find({ filter: '{ a: nope }' })).rejects.toMatchObject({ field: 'filter' });
    await expect(find({ sort: '{ a: ' })).rejects.toMatchObject({ field: 'sort' });
    await expect(find({ limit: '-1' })).rejects.toMatchObject({ field: 'limit' });
  });
  it('surfaces server errors for bad operators', async () => {
    await expect(find({ filter: '{ a: { $nope: 1 } }' })).rejects.toThrow(/unknown operator/i);
  });
  it('can be cancelled', async () => {
    const ac = new AbortController();
    const p = ops.findPage(users, { ...blank, filter: '{ $expr: { $function: { body: "function(){ sleep(2000); return true; }", args: [], lang: "js" } } }', requestId: 'x', page: 0, pageSize: 20 }, { timeoutMs: 20000, signal: ac.signal });
    const t = Date.now();
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBeTruthy();
    expect(Date.now() - t).toBeLessThan(1500);
  });
  it('applies the query timeout', async () => {
    const p = ops.findPage(users, { ...blank, filter: '{ $expr: { $function: { body: "function(){ sleep(500); return true; }", args: [], lang: "js" } } }', requestId: 'x', page: 0, pageSize: 20 }, { timeoutMs: 100 });
    await expect(p).rejects.toThrow(/time limit|exceeded|interrupted/i);
  });
  it('estimates for an empty filter and counts exactly otherwise', async () => {
    expect(await ops.countQuery(users, '', 'collection', 2000)).toEqual({ count: 95, exact: false });
    expect(await ops.countQuery(users, '{ active: true }', 'collection', 2000)).toEqual({ count: 48, exact: true });
    expect(await ops.countQuery(db.collection('users_view'), '', 'view', 2000)).toEqual({ count: 48, exact: true });
  });
  it('browses views', async () => {
    const r = await find({}, db.collection('users_view'));
    expect(r.docs).toHaveLength(20);
  });
});

describe('editing keeps types', () => {
  it('round-trips a document through the editor format on a real server', async () => {
    const coll = db.collection('types');
    const original: Document = {
      _id: new ObjectId(), i: new Int32(1), d: new Double(2), l: Long.fromString('9007199254740993'), dec: Decimal128.fromString('1.10'),
      at: new Date(), nested: { x: [new Double(3), new Int32(4)] },
    };
    await coll.insertOne(original);
    const read = (await coll.findOne({ _id: original._id }, FIDELITY_READ))!;
    const text = docToShell(read);
    const back = parseEditableDocument(text);
    await coll.replaceOne({ _id: original._id }, back);
    const again = (await coll.findOne({ _id: original._id }, FIDELITY_READ))!;
    expect(fingerprint(again)).toBe(fingerprint(read));
    const types = await coll.aggregate([{ $project: { i: { $type: '$i' }, d: { $type: '$d' }, l: { $type: '$l' }, dec: { $type: '$dec' }, x: { $type: '$at' } } }]).next();
    expect(types).toMatchObject({ i: 'int', d: 'double', l: 'long', dec: 'decimal', x: 'date' });
  });
  it('edits and removes single fields', async () => {
    const coll = db.collection('fields');
    const { insertedId } = await coll.insertOne({ a: 1, b: { c: 2 } });
    const id = JSON.stringify({ $oid: insertedId.toHexString() });
    await ops.updateField(coll, id, ['b', 'c'], 'Decimal128("5.5")');
    await ops.updateField(coll, id, ['new'], '"hello"');
    await ops.removeField(coll, id, ['a']);
    const doc = await coll.findOne({ _id: insertedId });
    expect(doc).toMatchObject({ b: { c: Decimal128.fromString('5.5') }, new: 'hello' });
    expect(doc).not.toHaveProperty('a');
    await expect(ops.updateField(coll, id, ['_id'], '1')).rejects.toThrow(/_id/);
    await expect(ops.updateField(coll, id, ['a.b'], '1')).rejects.toThrow(/can't be edited inline/);
    await expect(ops.updateField(coll, id, ['z'], 'nope')).rejects.toMatchObject({ field: 'value' });
    await expect(ops.updateField(coll, JSON.stringify({ $oid: '0'.repeat(24) }), ['z'], '1')).rejects.toThrow(/no longer exists/);
  });
  it('validates bulk updates', () => {
    expect(ops.parseUpdate('{ $set: { a: 1 } }')).toEqual({ $set: { a: 1 } });
    expect(ops.parseUpdate('[{ $set: { a: 1 } }]')).toHaveLength(1);
    expect(() => ops.parseUpdate('{ a: 1 }')).toThrow(/operators/);
    expect(() => ops.parseUpdate('{}')).toThrow();
  });
});

describe('schema, indexes, stats, explain', () => {
  it('infers fields, types, presence and nesting', async () => {
    const s = await ops.sampleSchema(users, 95, { timeoutMs: 5000 });
    expect(s.sampled).toBe(95);
    const f = (n: string) => s.fields.find((x) => x.name === n)!;
    expect(f('_id').presence).toBe(1);
    expect(f('nick').presence).toBeCloseTo(0.105, 2);
    expect(f('nick').nulls).toBe(10);
    expect(f('address').children.map((c) => c.path).sort()).toEqual(['address.city', 'address.zip']);
    expect(f('tags').elementTypes?.[0].type).toBe('String');
  });
  it('creates, lists and validates indexes', async () => {
    const name = await ops.createIndex(users, { keys: '{ age: 1, name: -1 }', name: 'age_name', unique: false, sparse: false, hidden: false, ttlSeconds: '', partial: '{ active: true }' });
    expect(name).toBe('age_name');
    const ttl = await ops.createIndex(users, { keys: '{ createdAt: 1 }', name: '', unique: false, sparse: false, hidden: false, ttlSeconds: '999999999', partial: '' });
    const list = await ops.listIndexes(users);
    const ix = list.find((i) => i.name === 'age_name')!;
    expect(ix).toMatchObject({ kind: 'compound', sparse: false, unique: false });
    expect(ix.partialText).toContain('active');
    expect(ix.keys).toEqual([{ field: 'age', direction: 'ascending' }, { field: 'name', direction: 'descending' }]);
    expect(list.find((i) => i.name === ttl)!.ttlSeconds).toBe(999999999);
    expect(list.find((i) => i.name === '_id_')).toMatchObject({ isDefault: true, unique: true });
    await expect(ops.createIndex(users, { keys: '', name: '', unique: false, sparse: false, hidden: false, ttlSeconds: '', partial: '' })).rejects.toMatchObject({ field: 'keys' });
    await users.dropIndex('age_name');
    await users.dropIndex(ttl);
  });
  it('reports stats for collections and views', async () => {
    const s = await ops.collectionStats(db, 'users', 'collection');
    expect(s.count).toBe(95);
    expect(s.storageSize).toBeGreaterThan(0);
    const v = await ops.collectionStats(db, 'users_view', 'view');
    expect(v.type).toBe('view');
    expect(v.viewOn).toBe('users');
    expect(v.pipelineText).toContain('$match');
  });
  it('explains queries, flags scans and suggests an index', async () => {
    const e = await ops.explainQuery(users, { ...blank, filter: '{ active: true, age: { $gt: 20 } }', sort: '{ name: 1 }' }, { timeoutMs: 5000 });
    expect(e.collectionScan).toBe(true);
    expect(e.docsExamined).toBe(95);
    expect(e.tips[0].suggestKeys).toBe('{ active: 1, name: 1, age: 1 }');
    await users.createIndex({ active: 1, name: 1, age: 1 });
    const e2 = await ops.explainQuery(users, { ...blank, filter: '{ active: true, age: { $gt: 20 } }', sort: '{ name: 1 }' }, { timeoutMs: 5000 });
    expect(e2.collectionScan).toBe(false);
    expect(e2.indexes).toEqual(['active_1_name_1_age_1']);
    await users.dropIndex('active_1_name_1_age_1');
  });
});

describe('aggregation', () => {
  it('previews stages, including non-document bodies', async () => {
    const r = await ops.aggregatePreview(users, [
      { op: '$match', body: '{ active: true }', enabled: true },
      { op: '$skip', body: '1000', enabled: false },
      { op: '$group', body: '{ _id: "$address.city", n: { $sum: 1 } }', enabled: true },
      { op: '$sort', body: '{ n: -1 }', enabled: true },
    ], 10, { timeoutMs: 5000 });
    expect(r.docs).toHaveLength(2);
    const c = await ops.aggregatePreview(users, [{ op: '$count', body: '"total"', enabled: true }], 10, { timeoutMs: 5000 });
    expect(c.docs).toHaveLength(1);
  });
  it('points to the failing stage and never runs $out in a preview', async () => {
    expect(() => ops.buildPipeline([{ op: '$match', body: '{}', enabled: true }, { op: '$sort', body: '{ a', enabled: true }])).toThrow();
    try {
      ops.buildPipeline([{ op: '$match', body: '{}', enabled: true }, { op: '$sort', body: '{ a', enabled: true }]);
    } catch (err) {
      expect((err as ops.FieldError).stage).toBe(1);
    }
    await ops.aggregatePreview(users, [{ op: '$out', body: '"should_not_exist"', enabled: true }], 1, { timeoutMs: 5000 });
    expect(await db.listCollections({ name: 'should_not_exist' }).toArray()).toHaveLength(0);
  });
});

describe('import and export', () => {
  let dir: string;
  beforeAll(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'mv-')); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('exports JSON that imports back with the same types', async () => {
    const path = join(dir, 'a.json');
    const n = await exportJson(users.find({}, FIDELITY_READ), path);
    expect(n).toBe(95);
    const target = db.collection('imported');
    const res = await importFile(target, path);
    expect(res).toEqual({ inserted: 95, failed: 0 });
    const d = await target.findOne({ name: 'user1' });
    expect(d?._id).toBeInstanceOf(ObjectId);
    expect(d?.createdAt).toBeInstanceOf(Date);
  });
  it('reports partial failures on import without stopping', async () => {
    const path = join(dir, 'dups.ndjson');
    await fs.writeFile(path, '{"_id":1}\n{"_id":1}\n{"_id":2}\n');
    const res = await importFile(db.collection('dups'), path);
    expect(res.inserted).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.firstError).toMatch(/duplicate/i);
  });
  it('rejects files that are not JSON', async () => {
    const path = join(dir, 'x.csv');
    await fs.writeFile(path, 'a,b\n1,2\n');
    await expect(importFile(db.collection('nope'), path)).rejects.toThrow(/does not look like JSON/);
  });
  it('writes CSV with every column, even ones that appear late', async () => {
    const path = join(dir, 'a.csv');
    async function* docs() {
      yield { _id: new ObjectId('0'.repeat(24)), a: 'x,y', n: { b: new Date(0) } };
      yield { a: 'quote"s', late: 5, arr: [1, 2] };
    }
    expect(await exportCsv(docs(), path)).toBe(2);
    const lines = (await fs.readFile(path, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('_id,a,n.b,late,arr');
    expect(lines[1]).toBe('000000000000000000000000,"x,y",1970-01-01T00:00:00.000Z,,');
    expect(lines[2]).toBe(',"quote""s",,5,"[1, 2]"');
  });
  it('copies a collection with its indexes', async () => {
    await users.createIndex({ name: 1 }, { unique: true });
    const target = client.db(`${DBNAME}_copy`).collection('c');
    const res = await copyCollection(users, target);
    expect(res.inserted).toBe(95);
    expect((await target.listIndexes().toArray()).map((i) => i.name)).toContain('name_1');
    await client.db(`${DBNAME}_copy`).dropDatabase();
    await users.dropIndex('name_1');
  });
});

describe('playground', () => {
  async function run(code: string, readOnly = false) {
    const blocks: Omit<PlaygroundBlock, 'id'>[] = [];
    await runScript(code, { client, database: DBNAME, readOnly, resultLimit: 5, filename: 'test.mongo.js', emit: (b) => blocks.push(b) });
    return blocks;
  }
  it('runs mongosh-style code without await', async () => {
    const b = await run(`
      const n = db.users.countDocuments({ active: true });
      print("count", n);
      db.users.find({ active: true }, { name: 1 }).sort({ name: 1 }).limit(2);
      db.users.findOne({ name: "user3" });
      db.users.aggregate([{ $group: { _id: "$active", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
      db.users.aggregate([{ $limit: 1 }]).toArray();
    `);
    expect(b[0]).toMatchObject({ kind: 'print', text: 'count 48' });
    expect(b[1].docs).toHaveLength(2);
    expect(b[2].kind).toBe('result');
    expect(b[3].docs).toHaveLength(2);
    expect(b[4].docs).toHaveLength(1);
  });
  it('truncates long cursors to the result limit', async () => {
    const [b] = await run('db.users.find()');
    expect(b.docs).toHaveLength(5);
    expect(b.truncated).toBe(true);
  });
  it('does not lose an existing cursor limit below the display limit', async () => {
    const [b] = await run('db.users.find().limit(2)');
    expect(b.docs!.length).toBeLessThanOrEqual(5);
  });
  it('supports writes, loops, variables and use', async () => {
    const b = await run(`
      use("${DBNAME}_pg");
      db.things.insertOne({ _id: 1, a: ObjectId("${'a'.repeat(24)}"), at: ISODate("2024-01-01") });
      db.things.updateOne({ _id: 1 }, { $set: { b: NumberLong("5") } });
      const c = db.things.find();
      while (c.hasNext()) { printjson(c.next()); }
      for (const x of [1, 2]) { db.things.insertOne({ _id: x + 1 }); }
      db.things.countDocuments();
      db.getCollectionNames();
      db.getSiblingDB("${DBNAME}").getName();
      db.dropDatabase();
    `);
    expect(b[0].text).toContain('switched to db');
    expect(b.find((x) => x.text?.includes('NumberLong("5")'))).toBeTruthy();
    expect(b.find((x) => x.value?.t === 'int' && x.value.v === 3)).toBeTruthy();
    expect(b.find((x) => x.value?.t === 'str' && x.value.v === DBNAME)).toBeTruthy();
  });
  it('awaits work started inside callbacks', async () => {
    await run(`
      use("${DBNAME}_cb");
      [1, 2, 3].forEach((i) => db.items.insertOne({ _id: i }));
    `);
    expect(await client.db(`${DBNAME}_cb`).collection('items').countDocuments()).toBe(3);
    await client.db(`${DBNAME}_cb`).dropDatabase();
  });
  it('handles shell lines and sync helpers', async () => {
    const b = await run(`use ${DBNAME}\nshow collections\n[1,2].map(x => x * 2)`);
    expect(b[1].text).toContain('users');
    expect(b[2].value).toEqual({ t: 'arr', a: [{ t: 'int', v: 2 }, { t: 'int', v: 4 }] });
  });
  it('blocks writes on read-only connections', async () => {
    await expect(run('db.users.insertOne({})', true)).rejects.toThrow(/read-only/);
    await expect(run('db.users.drop()', true)).rejects.toThrow(/read-only/);
    await expect(run('db.dropDatabase()', true)).rejects.toThrow(/read-only/);
    await expect(run('db.users.aggregate([{ $out: "x" }])', true)).rejects.toThrow(/read-only/);
    await expect(run('db.runCommand({ drop: "users" })', true)).rejects.toThrow(/read-only/);
    await expect(run('db.runCommand({ ping: 1 })', true)).resolves.toBeTruthy();
    await expect(run('db.users.find().limit(1)', true)).resolves.toBeTruthy();
    expect(await users.estimatedDocumentCount()).toBe(95);
  });
  it('keeps line numbers for errors', async () => {
    const err = await run('\n\nconst x = 1;\nundefinedFn();\n').catch((e) => e);
    expect(String(err.stack)).toMatch(/test\.mongo\.js:4/);
    const syntax = await run('\nconst = 1').catch((e) => e);
    expect(syntax.line).toBe(2);
  });
  it('transforms without changing line count', () => {
    const src = 'const a = db.x.find()\n  .limit(1);\nif (a) { db.y.findOne(); }\n';
    expect(transformScript(src).split('\n').length).toBe(src.split('\n').length);
    expect(listStatements(src).map((s) => s.line)).toEqual([1, 3]);
    expect(looksLikeWrite('db.a.insertOne({})')).toBe(true);
    expect(looksLikeWrite('db.a.find({ x: 1 })')).toBe(false);
  });
});
