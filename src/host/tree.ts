import * as vscode from 'vscode';
import type { Document } from 'mongodb';
import type { ConnectionManager } from './connections';
import { friendlyError } from './connections';
import { defaultDatabase, type ConnectionProfile, type Environment } from '../core/connectionString';

export type TreeNode =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string; sizeOnDisk?: number }
  | { kind: 'collection'; connectionId: string; database: string; collection: string; type: string }
  | { kind: 'message'; connectionId: string; text: string; icon?: string; tooltip?: string; command?: vscode.Command };

export interface CollectionRef { connectionId: string; database: string; collection: string; type: string }

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '')}M`;
  return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

const ENV_LABEL: Record<Environment, string> = { none: '', local: 'local', development: 'dev', staging: 'staging', production: 'PRODUCTION' };

const COLOR_THEME: Record<string, string> = {
  red: 'charts.red', orange: 'charts.orange', yellow: 'charts.yellow', green: 'charts.green', blue: 'charts.blue', purple: 'charts.purple',
};

/** Marks production connections in the tree with a badge and a colored label. */
export class ProductionDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'mongoviewer-tree') return undefined;
    const env = uri.path.slice(1);
    if (env === 'production') {
      return { badge: 'P', tooltip: 'Production connection', color: new vscode.ThemeColor('mongoViewer.production') };
    }
    return undefined;
  }
}

export class ExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
  private emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private filterText = '';
  private collectionCache = new Map<string, Document[]>();
  private databaseCache = new Map<string, { name: string; sizeOnDisk?: number }[]>();
  private counts = new Map<string, number | null>();
  private countQueue: (() => Promise<void>)[] = [];
  private activeCounts = 0;
  /** Expanded items, so they stay open when a filter changes their ids. */
  private expanded = new Set<string>();
  /** Changes when a connection closes, so its item collapses instead of reconnecting. */
  private generations = new Map<string, number>();
  /** Favorite keys, used to choose the right pin/unpin action. */
  isPinned: (ref: CollectionRef) => boolean = () => false;

  constructor(private connections: ConnectionManager) {
    connections.onDidChange((id) => {
      if (id) {
        const st = connections.state(id).status;
        if (st === 'disconnected') {
          this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
          for (const key of [...this.expanded]) if (key.startsWith(`conn:${id}`) || key.startsWith(`db:${id}/`)) this.expanded.delete(key);
        }
        if (st === 'disconnected' || st === 'error') this.invalidate(id);
      }
      this.emitter.fire();
    });
  }

  private nodeKey(node: TreeNode): string | undefined {
    if (node.kind === 'connection') return `conn:${node.connectionId}`;
    if (node.kind === 'database') return `db:${node.connectionId}/${node.database}`;
    return undefined;
  }

  setExpanded(node: TreeNode, expanded: boolean): void {
    const key = this.nodeKey(node);
    if (!key) return;
    if (expanded) this.expanded.add(key);
    else this.expanded.delete(key);
  }

  get filter(): string {
    return this.filterText;
  }

  setFilter(text: string): void {
    this.filterText = text.trim().toLowerCase();
    void vscode.commands.executeCommand('setContext', 'mongoViewer.filterActive', !!this.filterText);
    this.emitter.fire();
  }

  refresh(): void {
    this.emitter.fire();
  }

  invalidate(connectionId?: string, database?: string): void {
    const match = (key: string) => {
      if (!connectionId) return true;
      if (!key.startsWith(`${connectionId}/`)) return false;
      return !database || key.startsWith(`${connectionId}/${database}/`) || key === `${connectionId}/${database}`;
    };
    for (const m of [this.collectionCache, this.counts] as Map<string, unknown>[]) {
      for (const key of [...m.keys()]) if (match(key)) m.delete(key);
    }
    if (connectionId && !database) this.databaseCache.delete(connectionId);
    if (!connectionId) this.databaseCache.clear();
    this.emitter.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': return this.connectionItem(node.connectionId);
      case 'database': return this.databaseItem(node);
      case 'collection': return collectionItem(node, this.countText(node), this.isPinned(node), this.connections.get(node.connectionId), this.filterText);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
        item.tooltip = node.tooltip ?? node.text;
        item.command = node.command;
        return item;
      }
    }
  }

  private connectionItem(id: string): vscode.TreeItem {
    const p = this.connections.get(id);
    const st = this.connections.state(id);
    const item = new vscode.TreeItem(p?.name ?? 'Unknown', vscode.TreeItemCollapsibleState.Collapsed);
    if (!p) return item;
    item.id = `conn:${id}:${this.generations.get(id) ?? 0}${this.filterText ? ':f' : ''}`;
    if ((this.filterText && this.connections.isConnected(id)) || this.expanded.has(`conn:${id}`)) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    const connected = st.status === 'connected' || st.status === 'reconnecting';
    const rw = p.readOnly ? 'ro' : 'rw';
    item.contextValue = `connection.${connected ? 'connected' : 'disconnected'}.${rw}`;
    const color = p.color ? new vscode.ThemeColor(COLOR_THEME[p.color] ?? 'charts.green') : p.environment === 'production' ? new vscode.ThemeColor('mongoViewer.production') : undefined;
    const statusLabels: Record<typeof st.status, string> = {
      connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', reconnecting: 'Reconnecting…', error: 'Connection failed',
    };
    switch (st.status) {
      case 'connected': item.iconPath = new vscode.ThemeIcon('circle-filled', color ?? new vscode.ThemeColor('mongoViewer.connected')); break;
      case 'connecting': item.iconPath = new vscode.ThemeIcon('loading~spin'); break;
      case 'reconnecting': item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow')); break;
      case 'error': item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')); break;
      default: item.iconPath = new vscode.ThemeIcon('circle-outline', color);
    }
    const parts = [ENV_LABEL[p.environment], p.readOnly ? 'read-only' : '', st.status === 'reconnecting' ? 'reconnecting…' : '', p.ssh ? 'ssh' : ''].filter(Boolean);
    item.description = parts.join(' · ') || (connected ? '' : p.hostLabel);
    item.resourceUri = vscode.Uri.from({ scheme: 'mongoviewer-tree', path: `/${p.environment}` });
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${p.name}**\n\n`);
    tip.appendText(`${p.hostLabel}\n`);
    tip.appendMarkdown(`\n\n${statusLabels[st.status]}${st.version ? ` · MongoDB ${st.version}` : ''}`);
    if (p.environment !== 'none') tip.appendMarkdown(`\n\nEnvironment: ${p.environment}`);
    if (p.readOnly) tip.appendMarkdown('\n\nRead-only: writes are blocked');
    if (st.error) { tip.appendMarkdown('\n\n'); tip.appendText(st.error); }
    item.tooltip = tip;
    return item;
  }

  private databaseItem(node: Extract<TreeNode, { kind: 'database' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(node.database, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `db:${node.connectionId}/${node.database}:${this.generations.get(node.connectionId) ?? 0}${this.filterText ? ':f' : ''}`;
    if (this.filterText || this.expanded.has(`db:${node.connectionId}/${node.database}`)) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    item.iconPath = new vscode.ThemeIcon('database');
    const ro = this.connections.get(node.connectionId)?.readOnly;
    item.contextValue = `database.${ro ? 'ro' : 'rw'}`;
    item.description = node.sizeOnDisk ? formatBytes(node.sizeOnDisk) : undefined;
    return item;
  }

  private countText(node: Extract<TreeNode, { kind: 'collection' }>): string | undefined {
    if (node.type === 'view') return 'view';
    const key = `${node.connectionId}/${node.database}/${node.collection}`;
    const c = this.counts.get(key);
    if (c === undefined) {
      this.queueCount(node, key);
      return undefined;
    }
    const n = c === null ? undefined : formatCount(c);
    return node.type === 'timeseries' ? `time series${n ? ` · ${n}` : ''}` : n;
  }

  /** Counts come from collection metadata, in the background, a few at a time. */
  private queueCount(node: Extract<TreeNode, { kind: 'collection' }>, key: string): void {
    this.counts.set(key, null);
    this.countQueue.push(async () => {
      try {
        const client = await this.connections.client(node.connectionId);
        const n = await client.db(node.database).collection(node.collection).estimatedDocumentCount({ maxTimeMS: 2000 });
        this.counts.set(key, n);
      } catch {
        this.counts.set(key, null);
      }
    });
    this.pumpCounts();
  }

  private pumpCounts(): void {
    while (this.activeCounts < 6 && this.countQueue.length) {
      const job = this.countQueue.shift()!;
      this.activeCounts++;
      void job().finally(() => {
        this.activeCounts--;
        this.pumpCounts();
        if (!this.countQueue.length && this.activeCounts === 0) this.emitter.fire();
      });
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.connections.list().map((c) => ({ kind: 'connection', connectionId: c.id }));
    }
    if (node.kind === 'connection') return this.databaseChildren(node.connectionId);
    if (node.kind === 'database') return this.collectionChildren(node.connectionId, node.database);
    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'database' || node.kind === 'message') return { kind: 'connection', connectionId: node.connectionId };
    if (node.kind === 'collection') return { kind: 'database', connectionId: node.connectionId, database: node.database };
    return undefined;
  }

  async listDatabases(id: string): Promise<{ name: string; sizeOnDisk?: number }[]> {
    const cached = this.databaseCache.get(id);
    if (cached) return cached;
    const client = await this.connections.client(id);
    let dbs: { name: string; sizeOnDisk?: number }[];
    try {
      const res = await client.db('admin').admin().listDatabases({ nameOnly: false, authorizedDatabases: true });
      dbs = res.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk as number | undefined }));
    } catch (err) {
      // Restricted users may not be able to list databases, but they can use the one in their URI.
      const fallback = defaultDatabase(await this.connections.secretUri(id));
      if (!fallback) throw err;
      dbs = [{ name: fallback }];
    }
    dbs.sort((a, b) => a.name.localeCompare(b.name));
    this.databaseCache.set(id, dbs);
    return dbs;
  }

  async listCollections(id: string, database: string): Promise<Document[]> {
    const key = `${id}/${database}`;
    const cached = this.collectionCache.get(key);
    if (cached) return cached;
    const client = await this.connections.client(id);
    const infos = (await client.db(database).listCollections({}, { authorizedCollections: true, nameOnly: false }).toArray()) as Document[];
    infos.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    this.collectionCache.set(key, infos);
    return infos;
  }

  private async databaseChildren(id: string): Promise<TreeNode[]> {
    // A failed connection stays failed until asked again. Retrying here would loop,
    // because each failure refreshes the tree, which would come straight back here.
    const state = this.connections.state(id);
    if (state.status === 'error') {
      return [{
        kind: 'message', connectionId: id, text: 'Could not connect. Click to retry.', icon: 'error', tooltip: state.error,
        command: { command: 'mongoViewer.reconnect', title: 'Retry', arguments: [{ kind: 'connection', connectionId: id }] },
      }];
    }
    try {
      const dbs = await this.listDatabases(id);
      let nodes = dbs;
      if (this.filterText) {
        const checks = await Promise.all(dbs.map(async (d) => {
          if (d.name.toLowerCase().includes(this.filterText)) return true;
          const colls = await this.listCollections(id, d.name).catch(() => []);
          return colls.some((c) => String(c.name).toLowerCase().includes(this.filterText));
        }));
        nodes = dbs.filter((_, i) => checks[i]);
        if (!nodes.length) return [{ kind: 'message', connectionId: id, text: 'No matches', icon: 'search-stop' }];
      }
      if (!nodes.length) return [{ kind: 'message', connectionId: id, text: 'No databases yet', icon: 'info' }];
      return nodes.map((d) => ({ kind: 'database', connectionId: id, database: d.name, sizeOnDisk: d.sizeOnDisk }));
    } catch (err) {
      return [{
        kind: 'message', connectionId: id, text: friendlyError(err).slice(0, 120), icon: 'error', tooltip: friendlyError(err),
        command: { command: 'mongoViewer.reconnect', title: 'Retry', arguments: [{ kind: 'connection', connectionId: id }] },
      }];
    }
  }

  private async collectionChildren(id: string, database: string): Promise<TreeNode[]> {
    try {
      const showSystem = vscode.workspace.getConfiguration('mongoViewer').get('showSystemCollections', false);
      let infos = await this.listCollections(id, database);
      if (!showSystem) infos = infos.filter((c) => !String(c.name).startsWith('system.'));
      if (this.filterText && !database.toLowerCase().includes(this.filterText)) {
        infos = infos.filter((c) => String(c.name).toLowerCase().includes(this.filterText));
      }
      if (!infos.length) return [{ kind: 'message', connectionId: id, text: this.filterText ? 'No matches' : 'No collections yet', icon: 'info' }];
      return infos.map((c) => ({ kind: 'collection', connectionId: id, database, collection: String(c.name), type: String(c.type ?? 'collection') }));
    } catch (err) {
      return [{ kind: 'message', connectionId: id, text: friendlyError(err).slice(0, 120), icon: 'error', tooltip: friendlyError(err) }];
    }
  }
}

const TYPE_ICON: Record<string, string> = { view: 'eye', timeseries: 'pulse' };

export function collectionItem(
  node: CollectionRef, description: string | undefined, pinned: boolean, profile: ConnectionProfile | undefined, filter = '',
): vscode.TreeItem {
  const item = new vscode.TreeItem(node.collection);
  item.id = `coll:${node.connectionId}/${node.database}/${node.collection}${filter ? ':f' : ''}`;
  item.iconPath = new vscode.ThemeIcon(TYPE_ICON[node.type] ?? 'table');
  item.description = description;
  const writable = !profile?.readOnly && node.type !== 'view';
  item.contextValue = `collection.${node.type}.${writable ? 'rw' : 'ro'}.${pinned ? 'pinned' : 'unpinned'}`;
  item.tooltip = `${node.database}.${node.collection}${node.type !== 'collection' ? ` (${node.type})` : ''}`;
  item.command = { command: 'mongoViewer.openCollection', title: 'Open', arguments: [node] };
  return item;
}
