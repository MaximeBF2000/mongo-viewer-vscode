import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { join, basename } from 'node:path';
import { confirmWrite, friendlyError, type ConnectionManager } from './connections';
import { postEvent, renderHtml, serveRpc, webviewOptions, type Handlers } from './webview';
import { listStatements, looksLikeWrite, normalizeShellLines, ScriptSyntaxError } from '../playground/transform';
import type { WorkerInput } from '../playground/worker';
import type { PlaygroundApi, PlaygroundBlock, PlaygroundEvent } from '../shared/protocol';
import { wireToCsvCell, flattenWire, wireToShell } from '../shared/wire';
import { defaultDatabase } from '../core/connectionString';
import type { ExplorerProvider } from './tree';

interface Target { connectionId: string; database: string }

const TARGET_KEY = 'mongoViewer.playgroundTargets';
const cfg = () => vscode.workspace.getConfiguration('mongoViewer');

export class PlaygroundController implements vscode.Disposable {
  private status: vscode.StatusBarItem;
  private targets: Record<string, Target>;
  private lastTarget: Target | undefined;
  private worker?: Worker;
  private cancelRun?: () => void;
  private panel?: vscode.WebviewPanel;
  private panelReady?: Promise<void>;
  private diagnostics = vscode.languages.createDiagnosticCollection('mongoplayground');
  private subs: vscode.Disposable[] = [];
  private lensEmitter = new vscode.EventEmitter<void>();
  private blocks: PlaygroundBlock[] = [];

  constructor(private ctx: vscode.ExtensionContext, private connections: ConnectionManager, private explorer: ExplorerProvider) {
    this.targets = ctx.workspaceState.get(TARGET_KEY, {});
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'mongoViewer.choosePlaygroundTarget';
    this.subs.push(
      this.status,
      this.diagnostics,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      connections.onDidChange(() => { this.updateStatus(); this.lensEmitter.fire(); }),
      vscode.languages.registerCodeLensProvider({ language: 'mongoplayground' }, {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: (doc) => this.codeLenses(doc),
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'mongoplayground') this.diagnostics.delete(e.document.uri);
      }),
    );
    this.updateStatus();
  }

  private currentEditor(): vscode.TextEditor | undefined {
    const e = vscode.window.activeTextEditor;
    return e?.document.languageId === 'mongoplayground' ? e : vscode.window.visibleTextEditors.find((x) => x.document.languageId === 'mongoplayground');
  }

  getTarget(doc: vscode.TextDocument): Target | undefined {
    const t = this.targets[doc.uri.toString()] ?? this.lastTarget;
    return t && this.connections.get(t.connectionId) ? t : undefined;
  }

  private async setTarget(doc: vscode.TextDocument, target: Target): Promise<void> {
    this.targets[doc.uri.toString()] = target;
    this.lastTarget = target;
    await this.ctx.workspaceState.update(TARGET_KEY, this.targets);
    this.updateStatus();
  }

  private updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'mongoplayground') {
      this.status.hide();
      return;
    }
    const t = this.getTarget(doc);
    if (!t) {
      this.status.text = '$(database) Choose MongoDB connection';
      this.status.backgroundColor = undefined;
    } else {
      const p = this.connections.get(t.connectionId)!;
      this.status.text = `$(database) ${p.name} / ${t.database}`;
      this.status.backgroundColor = p.environment === 'production' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    }
    this.status.tooltip = 'Connection and database this playground runs against';
    this.status.show();
  }

  async chooseTarget(doc?: vscode.TextDocument): Promise<Target | undefined> {
    const document = doc ?? this.currentEditor()?.document;
    const profiles = this.connections.list();
    if (!profiles.length) {
      void vscode.window.showWarningMessage('Add a connection first.', 'Add Connection').then((c) => {
        if (c) void vscode.commands.executeCommand('mongoViewer.addConnection');
      });
      return undefined;
    }
    const pick = profiles.length === 1 ? { id: profiles[0].id } : await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name, description: p.environment === 'production' ? 'PRODUCTION' : p.hostLabel, id: p.id })),
      { title: 'Run playground against which connection?' },
    );
    if (!pick) return undefined;
    let names: string[] = [];
    try {
      names = (await this.explorer.listDatabases(pick.id)).map((d) => d.name);
    } catch (err) {
      void vscode.window.showErrorMessage(friendlyError(err));
      return undefined;
    }
    const uriDefault = defaultDatabase(await this.connections.secretUri(pick.id));
    const items = [...names.map((label) => ({ label })), { label: '$(add) Enter a database name…', custom: true }];
    const dbPick = await vscode.window.showQuickPick(items, { title: 'Database', placeHolder: uriDefault ?? 'Choose a database' });
    if (!dbPick) return undefined;
    let database = dbPick.label;
    if ('custom' in dbPick) {
      const typed = await vscode.window.showInputBox({ title: 'Database name' });
      if (!typed) return undefined;
      database = typed.trim();
    }
    const target = { connectionId: pick.id, database };
    if (document) await this.setTarget(document, target);
    return target;
  }

  /** Opens a new, unsaved playground. */
  async newPlayground(ref?: { connectionId: string; database?: string; collection?: string }): Promise<void> {
    const name = ref?.collection ?? 'collection';
    const accessor = /^[A-Za-z_$][\w$]*$/.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`;
    const content = [
      // VS Code titles an untitled tab with its first line, so make that line useful.
      ref?.database ? `use(${JSON.stringify(ref.database)});` : '// MongoDB Playground',
      '',
      '// Run everything with Cmd/Ctrl+Enter, or select some code to run just that.',
      '// Results for each top-level statement appear in the panel beside this editor.',
      `${accessor}.find({}).limit(10);`,
      '',
    ].join('\n');
    await this.openWithScript(ref?.connectionId, ref?.database, content);
  }

  async openWithScript(connectionId: string | undefined, database: string | undefined, content: string): Promise<void> {
    const body = database && !/^\s*use\(/.test(content) ? `use(${JSON.stringify(database)});\n\n${content}\n` : content;
    const doc = await vscode.workspace.openTextDocument({ language: 'mongoplayground', content: body });
    if (connectionId && database) await this.setTarget(doc, { connectionId, database });
    await vscode.window.showTextDocument(doc, { preview: false });
    this.updateStatus();
  }

  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    let statements;
    try {
      statements = listStatements(doc.getText());
    } catch {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    for (const s of statements) {
      if (s.isUse) continue;
      const range = new vscode.Range(s.line - 1, 0, s.line - 1, 0);
      lenses.push(new vscode.CodeLens(range, { title: '$(play) Run', command: 'mongoViewer.runStatement', arguments: [doc.uri, s.line] }));
    }
    return lenses;
  }

  /** Runs the selection if there is one, otherwise the whole script. */
  async run(): Promise<void> {
    const editor = this.currentEditor();
    if (!editor) {
      void vscode.window.showInformationMessage('Open a playground first.');
      return;
    }
    const selection = editor.selection;
    const selected = selection.isEmpty ? '' : editor.document.getText(selection);
    if (selected.trim()) {
      const prefixLines = '\n'.repeat(selection.start.line);
      await this.execute(editor.document, prefixLines + this.usePrefix(editor.document, selection.start.line) + selected, 'Selection');
    } else {
      await this.execute(editor.document, editor.document.getText(), 'Script');
    }
  }

  async runStatement(uri: vscode.Uri, line: number): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!doc) return;
    const statements = listStatements(doc.getText());
    const stmt = statements.find((s) => s.line === line);
    if (!stmt) return;
    await this.execute(doc, '\n'.repeat(line - 1) + this.usePrefix(doc, line - 1) + stmt.code, `Line ${line}`);
  }

  /** The nearest earlier use("db"), kept on one line so line numbers stay right. */
  private usePrefix(doc: vscode.TextDocument, beforeLine: number): string {
    const before = doc.getText(new vscode.Range(0, 0, beforeLine, 0));
    const matches = [...normalizeShellLines(before).matchAll(/^[ \t]*use\(\s*["'`]([^"'`]+)["'`]\s*\)/gm)];
    const last = matches.at(-1);
    return last ? `__quietUse(${JSON.stringify(last[1])});` : '';
  }

  cancel(): void {
    this.cancelRun?.();
  }

  private async ensurePanel(title: string): Promise<vscode.WebviewPanel> {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'mongoViewer.playgroundResults',
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        webviewOptions(this.ctx.extensionUri),
      );
      panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'file.svg');
      panel.webview.html = renderHtml(panel.webview, this.ctx.extensionUri, 'playground', title);
      this.panel = panel;
      this.panelReady = new Promise((resolve) => {
        const handlers: Handlers<PlaygroundApi> = {
          ready: () => resolve(),
          copyText: async ({ text, label }) => {
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage(`$(check) Copied ${label ?? 'to clipboard'}`, 2500);
          },
          cancel: () => this.cancel(),
          exportBlock: async ({ id, format }) => this.exportBlock(id, format),
        };
        const rpc = serveRpc<PlaygroundApi>(panel.webview, handlers, 'playground');
        panel.onDidDispose(() => {
          rpc.dispose();
          this.panel = undefined;
          this.panelReady = undefined;
        });
      });
    } else {
      this.panel.title = title;
      this.panel.reveal(undefined, true);
    }
    await this.panelReady;
    return this.panel;
  }

  private async execute(doc: vscode.TextDocument, code: string, label: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Playground scripts cannot run in an untrusted workspace.');
      return;
    }
    if (this.worker) {
      void vscode.window.showInformationMessage('A playground is already running. Cancel it first.');
      return;
    }
    const target = this.getTarget(doc) ?? (await this.chooseTarget(doc));
    if (!target) return;
    const profile = this.connections.get(target.connectionId)!;

    // Syntax errors surface in the editor without touching the database.
    this.diagnostics.delete(doc.uri);
    try {
      listStatements(code);
    } catch (err) {
      if (err instanceof ScriptSyntaxError) {
        this.markError(doc, err.message, err.line, err.col);
        void vscode.window.showErrorMessage(`Syntax error on line ${err.line}: ${err.message}`);
        return;
      }
      throw err;
    }
    if (looksLikeWrite(code) && profile.environment === 'production' && !profile.readOnly) {
      if (!(await confirmWrite(profile, 'run a script that appears to change data'))) return;
    }

    let uri: string;
    try {
      uri = await this.connections.effectiveUri(target.connectionId);
    } catch (err) {
      void vscode.window.showErrorMessage(friendlyError(err));
      return;
    }

    const title = `Results: ${basename(doc.fileName)}`;
    const panel = await this.ensurePanel(title);
    this.blocks = [];
    const send = (e: PlaygroundEvent) => postEvent(panel.webview, e);
    send({ name: 'start', title: label, target: `${profile.name} / ${target.database}`, environment: profile.environment });

    const start = performance.now();
    const input: WorkerInput = {
      uri,
      database: target.database,
      code,
      readOnly: profile.readOnly,
      resultLimit: cfg().get('playground.resultLimit', 100),
      filename: 'playground.mongo.js',
      connectTimeoutMs: cfg().get('connectTimeoutMs', 8000),
    };
    await vscode.commands.executeCommand('setContext', 'mongoViewer.playgroundRunning', true);
    const worker = new Worker(join(this.ctx.extensionPath, 'dist', 'playgroundWorker.js'), { workerData: input });
    this.worker = worker;
    let nextId = 1;
    let status: 'done' | 'error' | 'cancelled' = 'done';
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.worker = undefined;
      this.cancelRun = undefined;
      void vscode.commands.executeCommand('setContext', 'mongoViewer.playgroundRunning', false);
      send({ name: 'finish', ms: Math.round(performance.now() - start), status });
      void worker.terminate();
      this.explorer.invalidate(target.connectionId);
    };
    const emit = (b: Omit<PlaygroundBlock, 'id'>) => {
      const block: PlaygroundBlock = { ...b, id: nextId++ };
      this.blocks.push(block);
      send({ name: 'block', block });
    };
    this.cancelRun = () => {
      status = 'cancelled';
      emit({ kind: 'error', text: 'Cancelled.' });
      finish();
    };
    const timeoutMs = cfg().get('playground.timeoutMs', 300000);
    const timer = setTimeout(() => {
      status = 'error';
      emit({ kind: 'error', text: `Stopped after ${Math.round(timeoutMs / 1000)} seconds. You can change this in "mongoViewer.playground.timeoutMs".` });
      finish();
    }, timeoutMs);

    worker.on('message', (m: { type: string; block?: Omit<PlaygroundBlock, 'id'>; message?: string; line?: number; col?: number }) => {
      if (finished) return;
      if (m.type === 'block') emit(m.block!);
      else if (m.type === 'done') finish();
      else if (m.type === 'error') {
        status = 'error';
        emit({ kind: 'error', text: m.message, line: m.line });
        if (m.line) this.markError(doc, m.message ?? 'Error', m.line, m.col ?? 1);
        finish();
      }
    });
    worker.on('error', (err) => {
      if (finished) return;
      status = 'error';
      emit({ kind: 'error', text: friendlyError(err) });
      finish();
    });
    worker.on('exit', () => finish());
  }

  private markError(doc: vscode.TextDocument, message: string, line: number, col: number): void {
    const l = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
    const text = doc.lineAt(l);
    const range = new vscode.Range(l, Math.max(col - 1, text.firstNonWhitespaceCharacterIndex), l, Math.max(text.range.end.character, col));
    this.diagnostics.set(doc.uri, [new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error)]);
  }

  private async exportBlock(id: number, format: 'json' | 'csv'): Promise<void> {
    const block = this.blocks.find((b) => b.id === id);
    const docs = block?.docs?.map((d) => d.value) ?? (block?.value ? [block.value] : []);
    if (!docs.length) return;
    const target = await vscode.window.showSaveDialog({ filters: format === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] } });
    if (!target) return;
    let text: string;
    if (format === 'json') {
      text = `[\n${docs.map((d) => wireToShell(d, true)).join(',\n')}\n]\n`;
    } else {
      const rows = docs.map((d) => flattenWire(d));
      const cols = [...new Set(rows.flatMap((r) => r.map(([k]) => k)))];
      const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      text = [cols.map(esc).join(','), ...rows.map((r) => {
        const m = new Map(r);
        return cols.map((c) => { const v = m.get(c); return esc(v ? wireToCsvCell(v) : ''); }).join(',');
      })].join('\n') + '\n';
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    vscode.window.setStatusBarMessage('$(check) Results saved', 3000);
  }

  dispose(): void {
    void this.worker?.terminate();
    this.subs.forEach((s) => s.dispose());
    this.panel?.dispose();
  }
}
