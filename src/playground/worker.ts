// Runs one playground script in a worker thread, so a slow or endless script can't
// freeze the extension host, and cancelling is simply terminating the worker.
import { parentPort, workerData } from 'node:worker_threads';
import { MongoClient } from 'mongodb';
import { errorLine, runScript } from './runtime';
import { redact } from '../core/connectionString';

export interface WorkerInput {
  uri: string;
  database: string;
  code: string;
  readOnly: boolean;
  resultLimit: number;
  filename: string;
  connectTimeoutMs: number;
}

async function main(): Promise<void> {
  const input = workerData as WorkerInput;
  const post = (m: unknown) => parentPort!.postMessage(m);
  const client = new MongoClient(input.uri, { serverSelectionTimeoutMS: input.connectTimeoutMs, appName: 'mongo-viewer-playground' });
  try {
    await runScript(input.code, {
      client,
      database: input.database,
      readOnly: input.readOnly,
      resultLimit: input.resultLimit,
      filename: input.filename,
      emit: (block) => post({ type: 'block', block }),
    });
    post({ type: 'done' });
  } catch (err) {
    const message = redact((err as Error)?.message ?? String(err));
    post({ type: 'error', message, line: errorLine(err, input.filename), col: (err as { col?: number }).col });
  } finally {
    await client.close().catch(() => undefined);
  }
}

void main().then(() => process.exit(0));
