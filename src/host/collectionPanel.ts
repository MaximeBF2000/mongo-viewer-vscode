import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Collection, Document } from 'mongodb';
import { confirmDestructive, confirmWrite, type ConnectionManager } from './connections';
import { postEvent, renderHtml, serveRpc, webviewOptions, type Handlers } from './webview';
import * as ops from '../core/operations';
import { decodeId, FIDELITY_READ } from '../core/bsonCodec';
import { exportCsv, exportJson } from '../core/transfer';
import { generateQuery, listModels, type AiConfig } from '../core/ai';
import { flattenSchema } from '../core/schema';
import type {
  AggregationStage, CollectionApi, CollectionEvent, CollectionInit, CollectionTab, ExportScope, QueryInput, SavedQuery,
} from '../shared/protocol';
import type { CollectionRef, ExplorerProvider } from './tree';
import type { DocumentFs } from './docFs';
import type { FavoritesProvider } from './favorites';
import type { PlaygroundController } from './playground';
import type { ShellLauncher } from './shell';
import { importIntoCollection, runWithProgress, safeFileName } from './transferUi';

const VIEW_TYPE = 'mongoViewer.collection';
export const DEFAULT_AI_MODEL = 'qwen3.5:4b';

const cfg = () => vscode.workspace.getConfiguration('mongoViewer');

/** Lets the user swap the AI model from a list of what's installed in Ollama. */
export async function chooseAiModel(): Promise<void> {
  const endpoint = cfg().get('ai.endpoint', 'http://localhost:11434');
  const current = cfg().get('ai.model', DEFAULT_AI_MODEL);
  let models: { name: string; size?: number; capabilities?: string[] }[] = [];
  try {
    models = await listModels(endpoint);
  } catch (err) {
    void vscode.window.showWarningMessage((err as Error).message);
  }
  type Item = vscode.QuickPickItem & { custom?: boolean };
  const items: Item[] = models
    .filter((m) => !m.capabilities || m.capabilities.includes('completion'))
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
    .map((m) => ({
      label: m.name,
      description: [m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '', m.name === current ? 'current' : ''].filter(Boolean).join(' · '),
    }));
  items.push({ label: '$(edit) Enter a model name…', custom: true });
  const pick = await vscode.window.showQuickPick(items, { title: 'Choose AI Model', placeHolder: `Current: ${current}` });
  if (!pick) return;
  const name = pick.custom
    ? await vscode.window.showInputBox({ title: 'Ollama model name', value: current, prompt: 'For example qwen3.5:4b. Install new models with: ollama pull <name>' })
    : pick.label;
  if (!name?.trim()) return;
  await cfg().update('ai.model', name.trim(), vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`$(check) AI model: ${name.trim()}`, 3000);
}
const queryTimeout = () => cfg().get('queryTimeoutMs', 30000);

const blankQuery = (q: QueryInput) => !q.filter.trim() && !q.sort.trim() && !q.project.trim() && !q.limit.trim();
const sameQuery = (a: QueryInput, b: QueryInput) =>
  a.filter === b.filter && a.sort === b.sort && a.project === b.project && a.limit === b.limit;

export interface PanelDeps {
  ctx: vscode.ExtensionContext;
  connections: ConnectionManager;
  explorer: ExplorerProvider;
  docs: DocumentFs;
  favorites: FavoritesProvider;
  playground: PlaygroundController;
  shell: ShellLauncher;
}

export class CollectionPanels {
  private panels = new Map<string, CollectionPanel>();

  constructor(private deps: PanelDeps) {
    deps.docs.onDidChangeCollection((key) => {
      for (const [k, p] of this.panels) if (k === key) p.post({ name: 'refresh' });
    });
  }

  private key(ref: { connectionId: string; database: string; collection: string }): string {
    return `${ref.connectionId}/${ref.database}/${ref.collection}`;
  }

  open(ref: CollectionRef, tab: CollectionTab = 'documents'): void {
    const key = this.key(ref);
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(tab);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, ref.collection, vscode.ViewColumn.Active, webviewOptions(this.deps.ctx.extensionUri));
    this.attach(panel, ref, tab, false);
    void this.deps.favorites.recordRecent(ref);
  }

  /** Brings a panel back after a window reload. */
  restore(panel: vscode.WebviewPanel, state: { ref?: CollectionRef } | undefined): void {
    if (!state?.ref || !this.deps.connections.get(state.ref.connectionId)) {
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.deps.ctx.extensionUri);
    this.attach(panel, state.ref, 'documents', true);
  }

  private attach(panel: vscode.WebviewPanel, ref: CollectionRef, tab: CollectionTab, restored: boolean): void {
    const key = this.key(ref);
    const instance = new CollectionPanel(panel, ref, tab, restored, this.deps);
    this.panels.set(key, instance);
    panel.onDidDispose(() => this.panels.delete(key));
  }

  closeForCollection(ref: { connectionId: string; database?: string; collection?: string }): void {
    for (const p of [...this.panels.values()]) if (p.matches(ref)) p.dispose();
  }
}

class CollectionPanel {
  private running = new Map<string, AbortController>();
  private rpc: vscode.Disposable;

  constructor(
    private panel: vscode.WebviewPanel,
    private ref: CollectionRef,
    private tab: CollectionTab,
    private restored: boolean,
    private deps: PanelDeps,
  ) {
    const profile = deps.connections.get(ref.connectionId);
    panel.title = ref.collection;
    panel.iconPath = vscode.Uri.joinPath(deps.ctx.extensionUri, 'media', 'file.svg');
    if (profile?.environment === 'production') panel.title = `${ref.collection} (production)`;
    panel.webview.html = renderHtml(panel.webview, deps.ctx.extensionUri, 'collection', ref.collection);
    this.rpc = serveRpc<CollectionApi>(panel.webview, this.handlers(), 'collection');
    panel.onDidDispose(() => {
      this.rpc.dispose();
      for (const c of this.running.values()) c.abort();
    });
  }

  post(event: CollectionEvent): void {
    postEvent(this.panel.webview, event);
  }

  reveal(tab: CollectionTab): void {
    this.panel.reveal();
    this.post({ name: 'setTab', tab });
  }

  matches(r: { connectionId: string; database?: string; collection?: string }): boolean {
    return r.connectionId === this.ref.connectionId
      && (!r.database || r.database === this.ref.database)
      && (!r.collection || r.collection === this.ref.collection);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private profile() {
    const p = this.deps.connections.get(this.ref.connectionId);
    if (!p) throw new Error('This connection no longer exists.');
    return p;
  }

  private async coll(): Promise<Collection> {
    const client = await this.deps.connections.client(this.ref.connectionId);
    return client.db(this.ref.database).collection(this.ref.collection);
  }

  private async db() {
    const client = await this.deps.connections.client(this.ref.connectionId);
    return client.db(this.ref.database);
  }

  private abortable(requestId: string): AbortSignal {
    const c = new AbortController();
    this.running.set(requestId, c);
    return c.signal;
  }

  private canWrite(): boolean {
    return !this.profile().readOnly && this.ref.type !== 'view';
  }

  private async guard(action: string): Promise<boolean> {
    if (this.ref.type === 'view') {
      void vscode.window.showWarningMessage('Views are read-only.');
      return false;
    }
    return confirmWrite(this.profile(), action);
  }

  private historyKey(kind: 'history' | 'saved'): string {
    return `mongoViewer.${kind}.${this.ref.connectionId}/${this.ref.database}/${this.ref.collection}`;
  }

  private handlers(): Handlers<CollectionApi> {
    const { connections, docs, ctx } = this.deps;
    const ref = this.ref;
    return {
      init: async (): Promise<CollectionInit> => {
        const p = this.profile();
        const init: CollectionInit = {
          connectionId: ref.connectionId,
          connectionName: p.name,
          hostLabel: p.hostLabel,
          environment: p.environment,
          color: p.color,
          readOnly: p.readOnly,
          database: ref.database,
          collection: ref.collection,
          collectionType: ref.type,
          canWrite: this.canWrite(),
          pageSize: ctx.globalState.get('mongoViewer.pageSize', cfg().get('defaultPageSize', 20)),
          defaultView: cfg().get('defaultView', 'table'),
          tab: this.tab,
          aiEnabled: cfg().get('ai.enabled', true),
          aiModel: cfg().get('ai.model', DEFAULT_AI_MODEL),
          restored: this.restored,
        };
        return init;
      },

      find: async (req) => {
        const signal = this.abortable(req.requestId);
        try {
          return await ops.findPage(await this.coll(), req, { timeoutMs: queryTimeout(), signal });
        } finally {
          this.running.delete(req.requestId);
        }
      },

      cancel: ({ requestId }) => {
        this.running.get(requestId)?.abort();
      },

      count: async ({ filter }) => ops.countQuery(await this.coll(), filter, ref.type, cfg().get('countTimeoutMs', 3000)),

      suggestFields: async () => {
        const res = await ops.sampleSchema(await this.coll(), 200, { timeoutMs: 3000 });
        return flattenSchema(res.fields).map((f) => ({ path: f.path, type: f.types[0]?.type ?? '' }));
      },

      schema: async ({ sampleSize, requestId }) => {
        const signal = this.abortable(requestId);
        try {
          return await ops.sampleSchema(await this.coll(), sampleSize || cfg().get('schemaSampleSize', 500), { timeoutMs: queryTimeout(), signal });
        } finally {
          this.running.delete(requestId);
        }
      },

      indexes: async () => (ref.type === 'view' ? [] : ops.listIndexes(await this.coll())),

      createIndex: async (input) => {
        if (!(await this.guard(`create an index on ${ref.collection}`))) throw new Error('Cancelled');
        return ops.createIndex(await this.coll(), input);
      },

      dropIndex: async ({ name }) => {
        if (!(await confirmDestructive(`Drop the index "${name}"?`, `Queries on ${ref.collection} that use it will become slower. Rebuilding it can take a long time.`, 'Drop Index'))) return false;
        if (!(await this.guard(`drop the index ${name}`))) return false;
        await (await this.coll()).dropIndex(name);
        return true;
      },

      setIndexHidden: async ({ name, hidden }) => {
        if (!(await this.guard(`${hidden ? 'hide' : 'unhide'} the index ${name}`))) throw new Error('Cancelled');
        await (await this.db()).command({ collMod: ref.collection, index: { name, hidden } });
      },

      stats: async () => ops.collectionStats(await this.db(), ref.collection, ref.type),

      explain: async (q) => ops.explainQuery(await this.coll(), q, { timeoutMs: queryTimeout() }),

      aggregate: async ({ stages, limit, requestId }) => {
        const signal = this.abortable(requestId);
        try {
          return await ops.aggregatePreview(await this.coll(), stages, limit, { timeoutMs: queryTimeout(), signal });
        } finally {
          this.running.delete(requestId);
        }
      },

      aggregationToPlayground: async ({ stages }) => {
        await this.deps.playground.openWithScript(ref.connectionId, ref.database, ops.pipelineToScript(ref.collection, stages));
      },

      runAggregationToOutput: async ({ stages }) => {
        await this.runOutputPipeline(stages);
      },

      openDocument: async ({ id }) => {
        await docs.openDocument(ref, decodeId(id), this.canWrite());
      },

      insertDocument: async () => {
        if (!this.canWrite()) throw new Error('This collection is read-only.');
        await docs.openNewDocument(ref);
      },

      duplicateDocument: async ({ id }) => {
        if (!this.canWrite()) throw new Error('This collection is read-only.');
        await docs.openDuplicate(ref, decodeId(id));
      },

      deleteDocuments: async ({ ids }) => {
        if (!(await confirmDestructive(
          ids.length === 1 ? 'Delete this document?' : `Delete ${ids.length} documents?`,
          `From ${ref.database}.${ref.collection}. This can't be undone.`,
          'Delete',
        ))) return 0;
        if (!(await this.guard(`delete ${ids.length} document(s)`))) return 0;
        const r = await (await this.coll()).deleteMany(ops.idsToFilter(ids));
        this.afterWrite();
        return r.deletedCount;
      },

      deleteByQuery: async ({ query }) => {
        const parsed = ops.parseQuery(query);
        const coll = await this.coll();
        const n = await coll.countDocuments(parsed.filter, { maxTimeMS: queryTimeout() });
        if (!(await confirmDestructive(`Delete all ${n} matching documents?`, `From ${ref.database}.${ref.collection}. This can't be undone.`, 'Delete All'))) return 0;
        if (!(await this.guard(`delete ${n} documents`))) return 0;
        const r = await coll.deleteMany(parsed.filter);
        this.afterWrite();
        return r.deletedCount;
      },

      updateField: async ({ id, path, value }) => {
        if (!(await this.guard(`update the field ${path.join('.')}`))) throw new Error('Cancelled');
        await ops.updateField(await this.coll(), id, path, value);
        this.afterWrite(id);
      },

      removeField: async ({ id, path }) => {
        if (!(await confirmDestructive(`Remove the field "${path.join('.')}"?`, 'From this document.', 'Remove Field'))) return false;
        if (!(await this.guard(`remove the field ${path.join('.')}`))) return false;
        await ops.removeField(await this.coll(), id, path);
        this.afterWrite(id);
        return true;
      },

      bulkUpdate: async ({ scope, update }) => this.bulkUpdate(scope, update),

      promptBulkUpdate: async ({ scope, count }) => {
        const update = await vscode.window.showInputBox({
          title: `Update ${count} document${count === 1 ? '' : 's'} in ${ref.collection}`,
          prompt: 'An update document or aggregation pipeline.',
          placeHolder: '{ $set: { active: true } }',
          validateInput: (v) => {
            try {
              ops.parseUpdate(v);
              return null;
            } catch (err) {
              return (err as Error).message;
            }
          },
        });
        if (!update) return 0;
        return this.bulkUpdate(scope, update);
      },

      copyText: async ({ text, label }) => {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`$(check) Copied ${label ?? 'to clipboard'}`, 2500);
      },

      exportDocs: async ({ scope, format }) => this.exportDocs(scope, format),

      importDocs: async () => {
        if (!(await this.guard(`import documents into ${ref.collection}`))) return;
        await importIntoCollection(await this.coll(), ref.collection);
        this.afterWrite();
        this.deps.explorer.invalidate(ref.connectionId, ref.database);
      },

      toPlayground: async (q) => {
        await this.deps.playground.openWithScript(ref.connectionId, ref.database, ops.queryToScript(ref.collection, q));
      },

      openShell: async () => {
        await this.deps.shell.open(ref.connectionId, ref.database);
      },

      history: () => ({
        history: ctx.globalState.get<SavedQuery[]>(this.historyKey('history'), []),
        saved: ctx.globalState.get<SavedQuery[]>(this.historyKey('saved'), []),
      }),

      recordHistory: async (q) => {
        if (blankQuery(q)) return;
        const prev = ctx.globalState.get<SavedQuery[]>(this.historyKey('history'), []);
        const entry: SavedQuery = { filter: q.filter, sort: q.sort, project: q.project, limit: q.limit, id: randomUUID(), at: Date.now() };
        await ctx.globalState.update(this.historyKey('history'), [entry, ...prev.filter((x) => !sameQuery(x, q))].slice(0, 30));
      },

      saveQuery: async (q) => {
        const name = await vscode.window.showInputBox({ title: 'Save Query', prompt: 'Name this query', placeHolder: 'Active users over 18', validateInput: (v) => (v.trim() ? null : 'Enter a name') });
        if (!name) return null;
        const prev = ctx.globalState.get<SavedQuery[]>(this.historyKey('saved'), []);
        const entry: SavedQuery = { filter: q.filter, sort: q.sort, project: q.project, limit: q.limit, id: randomUUID(), at: Date.now(), name: name.trim() };
        await ctx.globalState.update(this.historyKey('saved'), [entry, ...prev]);
        return entry;
      },

      deleteSaved: async ({ id }) => {
        const prev = ctx.globalState.get<SavedQuery[]>(this.historyKey('saved'), []);
        await ctx.globalState.update(this.historyKey('saved'), prev.filter((x) => x.id !== id));
      },

      setPageSize: async ({ pageSize }) => {
        await ctx.globalState.update('mongoViewer.pageSize', pageSize);
      },

      ai: async ({ prompt, requestId }) => {
        const signal = this.abortable(requestId);
        const start = performance.now();
        try {
          const config: AiConfig = {
            endpoint: cfg().get('ai.endpoint', 'http://localhost:11434'),
            model: cfg().get('ai.model', DEFAULT_AI_MODEL),
            includeSampleValues: cfg().get('ai.includeSampleValues', true),
          };
          this.post({ name: 'aiProgress', requestId, status: 'Reading collection fields…' });
          const coll = await this.coll();
          const schema = await ops.sampleSchema(coll, 100, { timeoutMs: 5000, signal }).catch(() => ({ fields: [], sampled: 0 }));
          const res = await generateQuery(config, {
            prompt,
            collection: ref.collection,
            schema: schema.fields,
            signal,
            onStatus: (status) => this.post({ name: 'aiProgress', requestId, status }),
          });
          if (!res.modelExact) {
            void vscode.window.showInformationMessage(
              `"${config.model}" isn't installed in Ollama, so "${res.model}" was used. Install it with: ollama pull ${config.model}`,
            );
          }
          return {
            filter: res.filter, sort: res.sort, project: res.project, limit: res.limit, explanation: res.explanation,
            model: res.model, ms: Math.round(performance.now() - start), autoRun: cfg().get('ai.autoRun', false),
          };
        } finally {
          this.running.delete(requestId);
        }
      },

      chooseAiModel: async () => {
        await chooseAiModel();
        return cfg().get('ai.model', DEFAULT_AI_MODEL);
      },

      showError: ({ message }) => {
        void vscode.window.showErrorMessage(message);
      },
    };
  }

  private afterWrite(editedId?: string): void {
    this.post({ name: 'refresh' });
    this.deps.docs.notifyDocumentChanged(this.ref, editedId);
    this.deps.explorer.invalidate(this.ref.connectionId, this.ref.database);
  }

  private async bulkUpdate(scope: { ids: string[] } | { query: QueryInput }, update: string): Promise<number> {
    const body = ops.parseUpdate(update);
    const coll = await this.coll();
    const filter = 'ids' in scope ? ops.idsToFilter(scope.ids) : ops.parseQuery(scope.query).filter;
    const n = 'ids' in scope ? scope.ids.length : await coll.countDocuments(filter, { maxTimeMS: queryTimeout() });
    if (!(await confirmDestructive(`Update ${n} document${n === 1 ? '' : 's'}?`, `In ${this.ref.database}.${this.ref.collection}:\n${update}`, 'Update'))) return 0;
    if (!(await this.guard(`update ${n} document(s)`))) return 0;
    const r = await coll.updateMany(filter, body as Document);
    this.afterWrite();
    return r.modifiedCount;
  }

  private async exportDocs(scope: ExportScope, format: 'json' | 'csv' | undefined): Promise<void> {
    const coll = await this.coll();
    let chosen = format;
    if (!chosen) {
      const pick = await vscode.window.showQuickPick(['JSON', 'CSV'], { title: 'Export format' });
      if (!pick) return;
      chosen = pick.toLowerCase() as 'json' | 'csv';
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: defaultExportUri(`${this.ref.collection}.${chosen}`),
      filters: chosen === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] },
    });
    if (!target) return;

    let filter: Document;
    let options: Document = { ...FIDELITY_READ };
    if (scope.kind === 'selected') {
      filter = ops.idsToFilter(scope.ids);
    } else {
      const q = ops.parseQuery(scope.query);
      filter = q.filter;
      options = { ...options, sort: q.sort, projection: ops.hasValue(q.projection) ? q.projection : undefined };
      if (scope.kind === 'page') {
        options.skip = scope.page * scope.pageSize;
        options.limit = scope.pageSize;
      } else if (q.limit) {
        options.limit = q.limit;
      }
    }
    const exporter = chosen === 'json' ? exportJson : exportCsv;
    const n = await runWithProgress(`Exporting ${this.ref.collection}`, (progress, signal) =>
      exporter(coll.find(filter, options), target.fsPath, { signal, onProgress: (d) => progress(`${d.toLocaleString()} documents`) }));
    if (n === undefined) return;
    const open = await vscode.window.showInformationMessage(`Exported ${n.toLocaleString()} documents to ${safeFileName(target.fsPath)}.`, 'Open File');
    if (open) await vscode.commands.executeCommand('vscode.open', target);
  }

  private async runOutputPipeline(stages: AggregationStage[]): Promise<void> {
    const pipeline = ops.buildPipeline(stages);
    if (!ops.isWritePipeline(pipeline)) throw new Error('This pipeline has no $out or $merge stage.');
    if (!(await confirmDestructive('Run this pipeline and write its output?', 'The $out or $merge stage writes to a collection. $out replaces the target collection.', 'Run Pipeline'))) return;
    if (!(await confirmWrite(this.profile(), 'run a pipeline that writes output'))) return;
    await (await this.coll()).aggregate(pipeline, { maxTimeMS: queryTimeout() }).toArray();
    this.deps.explorer.invalidate(this.ref.connectionId, this.ref.database);
    vscode.window.setStatusBarMessage('$(check) Pipeline finished', 3000);
  }
}

function defaultExportUri(name: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, name) : undefined;
}
