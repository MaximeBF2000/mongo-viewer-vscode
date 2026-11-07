import * as vscode from 'vscode';
import { ConnectionManager, confirmDestructive, confirmWrite, friendlyError, log } from './host/connections';
import { ExplorerProvider, ProductionDecorations, type CollectionRef, type TreeNode } from './host/tree';
import { FavoritesProvider } from './host/favorites';
import { DocumentFs, DOC_SCHEME } from './host/docFs';
import { chooseAiModel, CollectionPanels } from './host/collectionPanel';
import { ConnectionForms, pickUriFromEnv } from './host/connectionForm';
import { ShellLauncher } from './host/shell';
import { PlaygroundController } from './host/playground';
import { registerLanguageFeatures } from './host/languageFeatures';
import { importIntoCollection, runWithProgress } from './host/transferUi';
import { redact, splitPassword } from './core/connectionString';
import { copyCollection, exportCsv, exportJson } from './core/transfer';
import { FIDELITY_READ } from './core/bsonCodec';
import type { CollectionTab } from './shared/protocol';

type ConnNode = Extract<TreeNode, { kind: 'connection' }>;
type DbNode = Extract<TreeNode, { kind: 'database' }>;

export function activate(ctx: vscode.ExtensionContext): { connections: ConnectionManager } {
  const connections = new ConnectionManager(ctx);
  const explorer = new ExplorerProvider(connections);
  const favorites = new FavoritesProvider(ctx, connections);
  explorer.isPinned = (r) => favorites.isPinned(r);
  const docs = new DocumentFs(connections);
  const shell = new ShellLauncher(ctx, connections);
  const playground = new PlaygroundController(ctx, connections, explorer);
  const panels = new CollectionPanels({ ctx, connections, explorer, docs, favorites, playground, shell });

  const treeView = vscode.window.createTreeView('mongoViewer.connections', { treeDataProvider: explorer, showCollapseAll: true });
  const favView = vscode.window.createTreeView('mongoViewer.favorites', { treeDataProvider: favorites });
  ctx.subscriptions.push(
    treeView.onDidExpandElement((e) => explorer.setExpanded(e.element, true)),
    treeView.onDidCollapseElement((e) => explorer.setExpanded(e.element, false)),
  );

  const forms = new ConnectionForms(ctx, connections, (profile, connect) => {
    explorer.invalidate(profile.id);
    if (connect) {
      void connections.client(profile.id)
        .then(() => treeView.reveal({ kind: 'connection', connectionId: profile.id }, { expand: true, focus: false, select: true }))
        .catch((err) => vscode.window.showErrorMessage(`Could not connect to "${profile.name}": ${(err as Error).message}`));
    }
  });

  const updateFilterMessage = () => {
    treeView.message = explorer.filter ? `Showing matches for "${explorer.filter}"` : undefined;
  };

  /** Resolves a command's target from the tree, or asks when run from the Command Palette. */
  const pickConnection = async (node?: { connectionId?: string }): Promise<string | undefined> => {
    if (node?.connectionId) return node.connectionId;
    const all = connections.list();
    if (all.length === 1) return all[0].id;
    const pick = await vscode.window.showQuickPick(all.map((c) => ({ label: c.name, description: c.hostLabel, id: c.id })), { title: 'Choose a connection' });
    return pick?.id;
  };

  const openCollection = (ref: CollectionRef, tab: CollectionTab = 'documents') => panels.open(ref, tab);

  const reportErrors = <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) => async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = friendlyError(err);
      log.error(message);
      void vscode.window.showErrorMessage(message);
    }
  };

  const validName = (kind: string) => (v: string) => {
    if (!v.trim()) return `Enter a ${kind} name`;
    if (/[$\0]/.test(v)) return `A ${kind} name can't contain $ or null characters`;
    if (kind === 'database' && /[/\\. "*<>:|?]/.test(v)) return 'A database name can\'t contain spaces or any of / \\ . " * < > : | ?';
    return null;
  };

  const commands: Record<string, (...args: never[]) => unknown> = {
    addConnection: () => forms.show(),
    importFromEnv: async () => {
      const res = await pickUriFromEnv();
      if (res) await forms.show(undefined, res);
    },
    editConnection: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      const p = id ? connections.get(id) : undefined;
      if (p) await forms.show(p);
    },
    removeConnection: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      const p = id ? connections.get(id) : undefined;
      if (!p || !id) return;
      if (!(await confirmDestructive(`Remove the connection "${p.name}"?`, 'This only forgets the saved connection. Nothing changes on the server.', 'Remove'))) return;
      await connections.remove(id);
      await favorites.removeConnection(id);
      panels.closeForCollection({ connectionId: id });
    },
    connect: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      if (!id) return;
      await connections.client(id);
      await treeView.reveal({ kind: 'connection', connectionId: id }, { expand: true, select: false });
    },
    disconnect: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      if (id) await connections.disconnect(id);
    },
    reconnect: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      if (!id) return;
      explorer.invalidate(id);
      await connections.reconnect(id);
      explorer.invalidate(id);
    },
    copyConnectionString: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      if (!id) return;
      const uri = await connections.secretUri(id);
      const split = splitPassword(uri);
      let text = split.uri;
      if (split.password) {
        const pick = await vscode.window.showQuickPick(
          [{ label: 'Without password', value: false }, { label: 'With password', description: 'The password goes on your clipboard', value: true }],
          { title: 'Copy connection string' },
        );
        if (!pick) return;
        if (pick.value) text = uri;
      }
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage('$(check) Connection string copied', 2500);
    },
    openShell: async (node?: { connectionId?: string; database?: string }) => {
      const id = await pickConnection(node);
      if (id) await shell.open(id, node?.database);
    },
    filterTree: async () => {
      const value = await vscode.window.showInputBox({ title: 'Filter Databases and Collections', value: explorer.filter, prompt: 'Searches connected connections by name.', placeHolder: 'users' });
      if (value === undefined) return;
      explorer.setFilter(value);
      updateFilterMessage();
    },
    clearTreeFilter: () => {
      explorer.setFilter('');
      updateFilterMessage();
    },
    refreshAll: () => explorer.invalidate(),
    refreshNode: (node?: TreeNode) => {
      if (node?.kind === 'database') explorer.invalidate(node.connectionId, node.database);
      else if (node) explorer.invalidate(node.connectionId);
    },
    goToCollection: async () => {
      type Item = vscode.QuickPickItem & { ref?: CollectionRef };
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = 'Go to Collection';
      qp.placeholder = 'Search collections in connected databases';
      qp.matchOnDescription = true;
      qp.busy = true;
      qp.show();
      qp.onDidAccept(() => {
        const ref = qp.selectedItems[0]?.ref;
        qp.hide();
        if (ref) openCollection(ref);
      });
      qp.onDidHide(() => qp.dispose());
      const items: Item[] = [];
      const active = connections.list().filter((c) => connections.isConnected(c.id));
      await Promise.all(active.map(async (c) => {
        const dbs = await explorer.listDatabases(c.id).catch(() => []);
        await Promise.all(dbs.map(async (d) => {
          const colls = await explorer.listCollections(c.id, d.name).catch(() => []);
          for (const info of colls) {
            const name = String(info.name);
            if (name.startsWith('system.')) continue;
            items.push({
              label: `$(${info.type === 'view' ? 'eye' : 'table'}) ${name}`,
              description: `${d.name} · ${c.name}`,
              ref: { connectionId: c.id, database: d.name, collection: name, type: String(info.type ?? 'collection') },
            });
          }
        }));
      }));
      items.sort((a, b) => a.label.localeCompare(b.label));
      qp.items = items;
      qp.busy = false;
      if (!active.length) qp.placeholder = 'No connections are open. Connect first in the Mongo Viewer sidebar.';
    },
    createDatabase: async (node?: ConnNode) => {
      const id = await pickConnection(node);
      if (!id) return;
      const profile = connections.get(id)!;
      const database = await vscode.window.showInputBox({ title: 'Create Database', prompt: 'Database name', validateInput: validName('database') });
      if (!database) return;
      const collection = await vscode.window.showInputBox({ title: `Create Database ${database}`, prompt: 'MongoDB creates a database with its first collection. Collection name:', validateInput: validName('collection') });
      if (!collection) return;
      if (!(await confirmWrite(profile, `create the database ${database}`))) return;
      await (await connections.client(id)).db(database.trim()).createCollection(collection.trim());
      explorer.invalidate(id);
    },
    dropDatabase: async (node?: DbNode) => {
      if (!node) return;
      const profile = connections.get(node.connectionId)!;
      const typed = await vscode.window.showInputBox({
        title: `Drop database "${node.database}"`,
        prompt: `This permanently deletes every collection in ${node.database}. Type the database name to confirm.`,
        validateInput: (v) => (v === node.database || !v ? null : 'The name does not match'),
      });
      if (typed !== node.database) return;
      if (!(await confirmDestructive(`Drop the database "${node.database}"?`, `On ${profile.name}. This can't be undone.`, 'Drop Database'))) return;
      if (!(await confirmWrite(profile, `drop the database ${node.database}`))) return;
      await (await connections.client(node.connectionId)).db(node.database).dropDatabase();
      panels.closeForCollection({ connectionId: node.connectionId, database: node.database });
      explorer.invalidate(node.connectionId);
    },
    createCollection: async (node?: DbNode) => {
      if (!node) return;
      const profile = connections.get(node.connectionId)!;
      const name = await vscode.window.showInputBox({ title: `Create Collection in ${node.database}`, prompt: 'Collection name', validateInput: validName('collection') });
      if (!name) return;
      if (!(await confirmWrite(profile, `create the collection ${name}`))) return;
      await (await connections.client(node.connectionId)).db(node.database).createCollection(name.trim());
      explorer.invalidate(node.connectionId, node.database);
    },
    dropCollection: async (node?: CollectionRef) => {
      if (!node) return;
      const profile = connections.get(node.connectionId)!;
      const kind = node.type === 'view' ? 'view' : 'collection';
      if (!(await confirmDestructive(`Drop the ${kind} "${node.collection}"?`, `From ${node.database} on ${profile.name}. All its documents and indexes will be deleted. This can't be undone.`, 'Drop'))) return;
      if (!(await confirmWrite(profile, `drop the ${kind} ${node.collection}`))) return;
      await (await connections.client(node.connectionId)).db(node.database).collection(node.collection).drop();
      panels.closeForCollection(node);
      explorer.invalidate(node.connectionId, node.database);
    },
    renameCollection: async (node?: CollectionRef) => {
      if (!node) return;
      const name = await vscode.window.showInputBox({ title: `Rename ${node.collection}`, value: node.collection, validateInput: validName('collection') });
      if (!name || name === node.collection) return;
      if (!(await confirmWrite(connections.get(node.connectionId)!, `rename ${node.collection}`))) return;
      await (await connections.client(node.connectionId)).db(node.database).collection(node.collection).rename(name.trim());
      panels.closeForCollection(node);
      explorer.invalidate(node.connectionId, node.database);
    },
    copyCollection: async (node?: CollectionRef) => {
      if (!node) return;
      const targets = connections.list();
      const conn = targets.length === 1 ? { id: targets[0].id } : await vscode.window.showQuickPick(
        targets.map((c) => ({ label: c.name, description: c.environment === 'production' ? 'PRODUCTION' : c.hostLabel, id: c.id })),
        { title: `Copy ${node.collection} to which connection?` },
      );
      if (!conn) return;
      const dbs = await explorer.listDatabases(conn.id);
      const dbPick = await vscode.window.showQuickPick([...dbs.map((d) => d.name), '$(add) New database…'], { title: 'Target database' });
      if (!dbPick) return;
      const database = dbPick.startsWith('$(add)')
        ? await vscode.window.showInputBox({ title: 'Target database name', validateInput: validName('database') })
        : dbPick;
      if (!database) return;
      const collection = await vscode.window.showInputBox({ title: 'Target collection name', value: `${node.collection}_copy`, validateInput: validName('collection') });
      if (!collection) return;
      if (!(await confirmWrite(connections.get(conn.id)!, `copy documents into ${database}.${collection}`))) return;
      const source = (await connections.client(node.connectionId)).db(node.database).collection(node.collection);
      const target = (await connections.client(conn.id)).db(database).collection(collection);
      const existing = await target.estimatedDocumentCount().catch(() => 0);
      if (existing > 0 && !(await confirmDestructive(`${database}.${collection} already has ${existing} documents.`, 'New documents will be added to it. Documents with the same _id are skipped.', 'Continue'))) return;
      const res = await runWithProgress(`Copying ${node.collection}`, (report, signal) =>
        copyCollection(source, target, { signal, onProgress: (n) => report(`${n.toLocaleString()} documents`) }));
      if (!res) return;
      explorer.invalidate(conn.id);
      void vscode.window.showInformationMessage(`Copied ${res.inserted.toLocaleString()} documents${res.failed ? `. ${res.failed} failed: ${res.firstError}` : '.'}`);
    },
    openCollection: (node?: CollectionRef) => { if (node) openCollection(node); },
    openSchema: (node?: CollectionRef) => { if (node) openCollection(node, 'schema'); },
    openIndexes: (node?: CollectionRef) => { if (node) openCollection(node, 'indexes'); },
    openStats: (node?: CollectionRef) => { if (node) openCollection(node, 'stats'); },
    openAggregation: (node?: CollectionRef) => { if (node) openCollection(node, 'aggregation'); },
    insertDocument: (node?: CollectionRef) => { if (node) return docs.openNewDocument(node); },
    importDocuments: async (node?: CollectionRef) => {
      if (!node) return;
      if (!(await confirmWrite(connections.get(node.connectionId)!, `import documents into ${node.collection}`))) return;
      await importIntoCollection((await connections.client(node.connectionId)).db(node.database).collection(node.collection), node.collection);
      explorer.invalidate(node.connectionId, node.database);
    },
    exportCollection: async (node?: CollectionRef) => {
      if (!node) return;
      const pick = await vscode.window.showQuickPick(['JSON', 'CSV'], { title: `Export all of ${node.collection}` });
      if (!pick) return;
      const ext = pick.toLowerCase();
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, `${node.collection}.${ext}`) : undefined,
        filters: { [pick]: [ext] },
      });
      if (!target) return;
      const coll = (await connections.client(node.connectionId)).db(node.database).collection(node.collection);
      const exporter = ext === 'json' ? exportJson : exportCsv;
      const n = await runWithProgress(`Exporting ${node.collection}`, (report, signal) =>
        exporter(coll.find({}, FIDELITY_READ), target.fsPath, { signal, onProgress: (d) => report(`${d.toLocaleString()} documents`) }));
      if (n !== undefined) void vscode.window.showInformationMessage(`Exported ${n.toLocaleString()} documents.`);
    },
    pinCollection: async (node?: CollectionRef) => {
      if (!node) return;
      await favorites.pin(node);
      explorer.refresh();
    },
    unpinCollection: async (node?: CollectionRef) => {
      if (!node) return;
      await favorites.unpin(node);
      explorer.refresh();
    },
    clearRecent: () => favorites.clearRecent(),
    copyName: async (node?: { collection?: string; database?: string }) => {
      await vscode.env.clipboard.writeText(node?.collection ?? node?.database ?? '');
    },
    newPlayground: (node?: { connectionId?: string; database?: string; collection?: string }) => {
      return playground.newPlayground(node?.connectionId ? { connectionId: node.connectionId, database: node.database, collection: node.collection } : undefined);
    },
    runPlayground: () => playground.run(),
    runStatement: (uri: vscode.Uri, line: number) => playground.runStatement(uri, line),
    cancelPlayground: () => playground.cancel(),
    choosePlaygroundTarget: () => playground.chooseTarget(),
    compareWithDatabase: (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === DOC_SCHEME) return docs.compareWithDatabase(target);
    },
    deleteOpenDocument: (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === DOC_SCHEME) return docs.deleteOpen(target);
    },
    duplicateOpenDocument: (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === DOC_SCHEME) return docs.duplicateOpen(target);
    },
    chooseAiModel: () => chooseAiModel(),
    showLogs: () => log.show(),
  };

  for (const [name, fn] of Object.entries(commands)) {
    ctx.subscriptions.push(vscode.commands.registerCommand(`mongoViewer.${name}`, reportErrors(fn as (...args: unknown[]) => unknown)));
  }

  ctx.subscriptions.push(
    connections,
    log,
    treeView,
    favView,
    shell,
    playground,
    vscode.window.registerFileDecorationProvider(new ProductionDecorations()),
    vscode.workspace.registerFileSystemProvider(DOC_SCHEME, docs, { isCaseSensitive: true }),
    vscode.window.registerWebviewPanelSerializer('mongoViewer.collection', {
      deserializeWebviewPanel: async (panel, state) => panels.restore(panel, state as { ref?: CollectionRef }),
    }),
    registerLanguageFeatures(connections, playground, explorer),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mongoViewer.showSystemCollections')) explorer.invalidate();
    }),
  );

  log.info(redact('Mongo Viewer activated'));
  return { connections };
}

export function deactivate(): void { /* Everything is disposed through subscriptions. */ }
