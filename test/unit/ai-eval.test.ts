// Checks real model output against real data. It needs Ollama, so it only runs on request:
//   MV_AI_EVAL=1 MV_AI_MODEL=qwen3.5:4b npx vitest run test/unit/ai-eval.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { MongoClient, type Collection, type Document } from 'mongodb';
import { generateQuery } from '../../src/core/ai';
import { sampleSchema, parseQuery } from '../../src/core/operations';
import type { SchemaField } from '../../src/shared/protocol';

const URI = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27099';
const MODEL = process.env.MV_AI_MODEL ?? 'qwen3.5:4b';
const ENDPOINT = 'http://localhost:11434';

type Check = (q: ReturnType<typeof parseQuery>, docs: Document[]) => boolean;

const CASES: [string, Check][] = [
  ['active users', (q) => q.filter.active === true],
  ['users older than 60', (q) => q.filter.age?.$gt === 60 || q.filter.age?.$gte === 61],
  ['people living in paris', (_, docs) => docs.length > 0 && docs.every((d) => d.address.city === 'Paris')],
  ['users on the pro or team plan', (q) => JSON.stringify(q.filter.plan?.$in ?? q.filter.$or ?? '').includes('pro')],
  ['the 5 newest users', (q) => q.limit === 5 && Number((q.sort as Document)?.createdAt) === -1],
  ['top 3 users by balance, only name and balance', (q) => q.limit === 3 && Number((q.sort as Document)?.balance) === -1 && !!q.projection?.name],
  ['users with a phone number', (q) => JSON.stringify(q.filter).includes('phone')],
  ['users created in 2024', (q) => JSON.stringify(q.filter).includes('createdAt')],
  ['emails containing garcia', (_, docs) => docs.length > 0 && docs.every((d) => /garcia/i.test(d.email))],
  ['inactive enterprise users younger than 30', (_, docs) => docs.length > 0 && docs.every((d) => d.active === false && d.plan === 'enterprise' && d.age < 30)],
];

describe.runIf(process.env.MV_AI_EVAL)('AI query generation', () => {
  let client: MongoClient;
  let users: Collection;
  let schema: SchemaField[];
  const results: string[] = [];
  let passed = 0;

  beforeAll(async () => {
    client = await new MongoClient(URI).connect();
    users = client.db('myapp').collection('users');
    schema = (await sampleSchema(users, 100, { timeoutMs: 5000 })).fields;
  });

  afterAll(async () => {
    const summary = `${results.join('\n')}\n\n${passed}/${CASES.length} correct with ${MODEL}\n`;
    console.log(summary);
    if (process.env.MV_AI_OUT) writeFileSync(process.env.MV_AI_OUT, summary);
    await client.close();
    // Free the model's memory right away instead of keeping it loaded.
    await fetch(`${ENDPOINT}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODEL, keep_alive: 0 }) }).catch(() => undefined);
  });

  it.each(CASES)('%s', async (prompt, check) => {
    const start = Date.now();
    let line = '';
    try {
      const res = await generateQuery({ endpoint: ENDPOINT, model: MODEL, includeSampleValues: true }, { prompt, collection: 'users', schema });
      const parsed = parseQuery({ filter: res.filter, sort: res.sort, project: res.project, limit: res.limit });
      const docs = await users.find(parsed.filter).sort(parsed.sort ?? {}).limit(parsed.limit ?? 20).toArray();
      const ok = check(parsed, docs);
      if (ok) passed++;
      line = `${ok ? 'ok  ' : 'BAD '} ${((Date.now() - start) / 1000).toFixed(1)}s  "${prompt}" -> filter=${res.filter || '{}'} sort=${res.sort} project=${res.project} limit=${res.limit}`;
    } catch (err) {
      line = `ERR  "${prompt}" -> ${(err as Error).message}`;
    }
    results.push(line);
    expect(line).toBeTruthy();
  }, 180000);
});
