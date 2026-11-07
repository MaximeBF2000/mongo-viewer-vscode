import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { FieldError } from '../core/operations';
import { ShellSyntaxError } from '../shared/shell';
import { friendlyError, log } from './connections';
import { redact } from '../core/connectionString';
import type { RpcError, RpcEvent, RpcRequest, RpcResponse } from '../shared/protocol';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
  };
}

export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', name)).toString();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&"]/g, '')}</title>
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
</head>
<body>
<div id="app" data-view="${view}"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}

export function toRpcError(err: unknown): RpcError {
  const e = err as Error & { code?: number };
  if (e?.name === 'AbortError' || /aborted|operation was cancel/i.test(e?.message ?? '')) {
    return { message: 'Cancelled', cancelled: true };
  }
  if (err instanceof FieldError) {
    const inner = err.inner;
    const pos = inner instanceof ShellSyntaxError ? { line: inner.line, col: inner.col } : {};
    return { message: inner.message, field: err.field, stage: err.stage, ...pos };
  }
  if (err instanceof ShellSyntaxError) return { message: err.message, line: err.line, col: err.col };
  if (e?.code === 50) return { message: 'The query hit its time limit and was stopped. Add an index, narrow the filter, or raise "mongoViewer.queryTimeoutMs".' };
  return { message: friendlyError(err) };
}

export type Handlers<A> = {
  [K in keyof A]: A[K] extends [infer P, infer R] ? (params: P) => Promise<R> | R : never;
};

/** Dispatches webview requests to handlers, and returns results or errors. */
export function serveRpc<A>(webview: vscode.Webview, handlers: Handlers<A>, name: string): vscode.Disposable {
  return webview.onDidReceiveMessage(async (msg: RpcRequest) => {
    if (msg?.type !== 'req') return;
    const respond = (r: Omit<RpcResponse, 'type' | 'id'>) => void webview.postMessage({ type: 'res', id: msg.id, ...r } satisfies RpcResponse);
    const handler = (handlers as Record<string, ((p: unknown) => unknown) | undefined>)[msg.method];
    if (!handler) {
      respond({ error: { message: `Unknown request ${msg.method}` } });
      return;
    }
    try {
      respond({ result: await handler(msg.params) });
    } catch (err) {
      const error = toRpcError(err);
      if (!error.cancelled && !error.field) log.warn(`${name}.${msg.method}: ${redact(error.message)}`);
      respond({ error });
    }
  });
}

export function postEvent(webview: vscode.Webview, event: unknown): void {
  void webview.postMessage({ type: 'event', event } satisfies RpcEvent);
}
