// Natural language to MongoDB queries through a local Ollama server.
import { parseQueryDocument } from './bsonCodec';
import { flattenSchema } from './schema';
import type { SchemaField } from '../shared/protocol';

export interface AiConfig {
  endpoint: string;
  model: string;
  includeSampleValues: boolean;
}

export interface GeneratedQuery {
  filter: string;
  sort: string;
  project: string;
  limit: string;
  explanation: string;
}

interface OllamaModel {
  name: string;
  size?: number;
  capabilities?: string[];
  details?: { family?: string };
}

export class AiError extends Error {}

const normalize = (s: string) => s.toLowerCase().replace(/^hf\.co\/[^/]+\//, '').replace(/[^a-z0-9]/g, '');

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Finds the best installed model for the configured name: exact, then ignoring
 * punctuation (qwen-3.6-35b-a-3b = qwen3.6:35b-a3b), then the smallest Qwen text
 * model. The fallback prefers small so it can't exhaust memory on a smaller machine.
 */
export function resolveModel(wanted: string, models: OllamaModel[]): { name: string; exact: boolean } | null {
  const exact = models.find((m) => m.name === wanted || m.name === `${wanted}:latest`);
  if (exact) return { name: exact.name, exact: true };
  const target = normalize(wanted);
  const loose = models.find((m) => {
    const n = normalize(m.name);
    return n === target || n === `${target}latest` || n.includes(target) || normalize(m.name.split(':')[0]) === target;
  });
  if (loose) return { name: loose.name, exact: true };
  const usable = models.filter((m) => {
    const caps = m.capabilities;
    return (!caps || caps.includes('completion')) && !/embed|ocr/i.test(m.name);
  });
  const qwen = usable
    .filter((m) => /qwen/i.test(m.name) || /qwen/i.test(m.details?.family ?? ''))
    .sort((a, b) => (/-vl|vl:/i.test(a.name) ? 1 : 0) - (/-vl|vl:/i.test(b.name) ? 1 : 0) || (a.size ?? 0) - (b.size ?? 0));
  if (qwen[0]) return { name: qwen[0].name, exact: false };
  const any = [...usable].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  return any[0] ? { name: any[0].name, exact: false } : null;
}

export async function listModels(endpoint: string, signal?: AbortSignal): Promise<OllamaModel[]> {
  let res: Response;
  try {
    res = await fetch(new URL('/api/tags', endpoint), { signal: signal ?? AbortSignal.timeout(3000) });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new AiError(`Can't reach Ollama at ${endpoint}. Is it running? Start it with "ollama serve".`);
  }
  if (!res.ok) throw new AiError(`Ollama returned ${res.status} when listing models.`);
  const body = (await res.json()) as { models?: OllamaModel[] };
  return body.models ?? [];
}

function summarizeSchema(fields: SchemaField[], withSamples: boolean): string {
  const lines = flattenSchema(fields).slice(0, 120).map((f) => {
    const types = (f.elementTypes ? f.elementTypes.map((t) => `Array<${t.type}>`) : f.types.map((t) => t.type)).slice(0, 3).join('|');
    const samples = withSamples && f.samples.length ? `  e.g. ${f.samples.slice(0, 3).join(', ')}` : '';
    return `${f.path}: ${types}${samples}`;
  });
  return lines.join('\n') || '(no documents to sample)';
}

export function systemPrompt(now: Date): string {
  return `You translate a request in plain language into a MongoDB find query. Today is ${now.toISOString()}.

Reply with JSON only, with these fields:
- filter: the filter document as a string in mongosh syntax. "{}" means everything.
- sort: the sort document as a string, or "" if no order was requested.
- projection: the projection document as a string, or "" unless specific fields were requested.
- limit: a number, or 0 unless a count was requested ("top 5", "the latest one").
- explanation: one short sentence describing what the query does.

Rules:
- Use only field paths from the schema. Use dot notation for nested fields.
- Match each value to the field's type in the schema. Copy the spelling and casing of example values.
- Dates are ISODate("2024-01-31T00:00:00Z"). Work out relative dates ("last week") from today. ObjectIds are ObjectId("...").
- For partial or case-insensitive text use { $regex: "text", $options: "i" }.
- For "A or B" on one field use $in. For conditions across fields use $or.
- "latest", "newest" and "recent" sort by the most relevant date field, descending. "top" and "highest" sort descending, "lowest" ascending.
- Never use $where, $function, $accumulator or $expr with JavaScript.

Examples, for a schema with status: String, age: Int32, createdAt: Date, address.city: String:
"active users over 18" -> {"filter":"{ status: \\"active\\", age: { $gt: 18 } }","sort":"","projection":"","limit":0,"explanation":"Active users older than 18."}
"5 newest people in paris, just their age" -> {"filter":"{ \\"address.city\\": { $regex: \\"^paris$\\", $options: \\"i\\" } }","sort":"{ createdAt: -1 }","projection":"{ age: 1 }","limit":5,"explanation":"The 5 most recently created people in Paris, showing age."}`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    filter: { type: 'string' },
    sort: { type: 'string' },
    projection: { type: 'string' },
    limit: { type: 'integer' },
    explanation: { type: 'string' },
  },
  required: ['filter', 'sort', 'projection', 'limit', 'explanation'],
} as const;

const FORBIDDEN = /\$(where|function|accumulator)\b/;

/** Checks model output before it reaches the query bar. */
export function validateGenerated(raw: Record<string, unknown>): GeneratedQuery {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? JSON.stringify(v) : '');
  const filter = text(raw.filter);
  const sort = text(raw.sort);
  const project = text(raw.projection);
  for (const [label, value] of [['filter', filter], ['sort', sort], ['projection', project]] as const) {
    if (FORBIDDEN.test(value)) throw new AiError(`The ${label} used a server-side JavaScript operator, which is not allowed.`);
    try {
      parseQueryDocument(value);
    } catch (err) {
      throw new AiError(`The ${label} was not valid: ${(err as Error).message}`);
    }
  }
  const limit = Number(raw.limit);
  return {
    filter: filter === '{}' ? '' : filter,
    sort: sort === '{}' ? '' : sort,
    project: project === '{}' ? '' : project,
    limit: Number.isInteger(limit) && limit > 0 ? String(limit) : '',
    explanation: text(raw.explanation),
  };
}

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

async function chat(endpoint: string, model: string, messages: ChatMessage[], signal?: AbortSignal, onStatus?: (s: string) => void): Promise<string> {
  let res: Response;
  try {
    res = await fetch(new URL('/api/chat', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: false,
        format: RESPONSE_SCHEMA,
        // Long enough for follow-up questions, without holding memory all day on a small machine.
        keep_alive: '10m',
        options: { temperature: 0, num_predict: 512, num_ctx: 8192 },
      }),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new AiError(`Can't reach Ollama at ${endpoint}. Is it running? Start it with "ollama serve".`);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new AiError(`Ollama returned ${res.status}: ${detail.slice(0, 200)}`);
  }
  let content = '';
  let buffer = '';
  const decoder = new TextDecoder();
  onStatus?.('Thinking…');
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (msg.error) throw new AiError(`Ollama: ${msg.error}`);
      if (msg.message?.content) {
        if (!content) onStatus?.('Writing query…');
        content += msg.message.content;
      }
    }
  }
  return content;
}

export interface GenerateInput {
  prompt: string;
  collection: string;
  schema: SchemaField[];
  now?: Date;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

export async function generateQuery(cfg: AiConfig, input: GenerateInput): Promise<GeneratedQuery & { model: string; modelExact: boolean }> {
  input.onStatus?.('Checking model…');
  const models = await listModels(cfg.endpoint, input.signal);
  const resolved = resolveModel(cfg.model, models);
  if (!resolved) throw new AiError(`Ollama has no usable models. Install one with: ollama pull ${cfg.model}`);
  const withSamples = cfg.includeSampleValues && isLocalEndpoint(cfg.endpoint);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input.now ?? new Date()) },
    {
      role: 'user',
      content: `Collection "${input.collection}" schema:\n${summarizeSchema(input.schema, withSamples)}\n\nRequest: ${input.prompt}`,
    },
  ];
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await chat(cfg.endpoint, resolved.name, messages, input.signal, input.onStatus);
    try {
      const raw = JSON.parse(content) as Record<string, unknown>;
      return { ...validateGenerated(raw), model: resolved.name, modelExact: resolved.exact };
    } catch (err) {
      lastError = err as Error;
      input.onStatus?.('Fixing query…');
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `That reply had a problem: ${lastError.message}\nReply again with corrected JSON.` });
    }
  }
  throw lastError instanceof AiError ? lastError : new AiError(`The model did not return a usable query: ${lastError?.message}`);
}
