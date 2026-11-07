import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { Collection } from 'mongodb';
import { importFile } from '../core/transfer';
import { friendlyError } from './connections';

export const safeFileName = (p: string) => basename(p);

/** Runs a long task with a cancellable notification. Returns undefined if cancelled. */
export async function runWithProgress<T>(
  title: string,
  task: (report: (message: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      try {
        return await task((message) => progress.report({ message }), ac.signal);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          void vscode.window.showInformationMessage(`${title}: cancelled.`);
          return undefined;
        }
        throw err;
      }
    },
  );
}

export async function importIntoCollection(coll: Collection, name: string): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    title: `Import into ${name}`,
    canSelectMany: false,
    filters: { 'JSON documents': ['json', 'ndjson', 'jsonl'], 'All files': ['*'] },
  });
  if (!files?.[0]) return;
  try {
    const res = await runWithProgress(`Importing into ${name}`, (report, signal) =>
      importFile(coll, files[0].fsPath, { signal, onProgress: (n) => report(`${n.toLocaleString()} documents`) }));
    if (!res) return;
    if (res.failed) {
      void vscode.window.showWarningMessage(
        `Imported ${res.inserted.toLocaleString()} documents. ${res.failed.toLocaleString()} failed: ${friendlyError(new Error(res.firstError ?? ''))}`,
      );
    } else {
      void vscode.window.showInformationMessage(`Imported ${res.inserted.toLocaleString()} documents into ${name}.`);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Import failed: ${friendlyError(err)}`);
  }
}
