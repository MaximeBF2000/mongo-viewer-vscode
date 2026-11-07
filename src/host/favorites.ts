import * as vscode from 'vscode';
import type { ConnectionManager } from './connections';
import { collectionItem, type CollectionRef } from './tree';

type Node = { group: 'favorites' | 'recent' } | (CollectionRef & { kind: 'collection'; from: 'favorites' | 'recent' });

const FAV_KEY = 'mongoViewer.favorites';
const RECENT_KEY = 'mongoViewer.recent';
const MAX_RECENT = 12;

const same = (a: CollectionRef, b: CollectionRef) =>
  a.connectionId === b.connectionId && a.database === b.database && a.collection === b.collection;
const plain = ({ connectionId, database, collection, type }: CollectionRef): CollectionRef => ({ connectionId, database, collection, type });

export class FavoritesProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext, private connections: ConnectionManager) {
    connections.onDidChange(() => this.emitter.fire());
  }

  private favorites(): CollectionRef[] {
    return this.ctx.globalState.get<CollectionRef[]>(FAV_KEY, []);
  }
  private recents(): CollectionRef[] {
    return this.ctx.globalState.get<CollectionRef[]>(RECENT_KEY, []);
  }

  isPinned(ref: CollectionRef): boolean {
    return this.favorites().some((f) => same(f, ref));
  }

  async pin(ref: CollectionRef): Promise<void> {
    if (!this.isPinned(ref)) await this.ctx.globalState.update(FAV_KEY, [...this.favorites(), plain(ref)]);
    this.emitter.fire();
  }

  async unpin(ref: CollectionRef): Promise<void> {
    await this.ctx.globalState.update(FAV_KEY, this.favorites().filter((f) => !same(f, ref)));
    this.emitter.fire();
  }

  async recordRecent(ref: CollectionRef): Promise<void> {
    const list = [plain(ref), ...this.recents().filter((r) => !same(r, ref))].slice(0, MAX_RECENT);
    await this.ctx.globalState.update(RECENT_KEY, list);
    this.emitter.fire();
  }

  async clearRecent(): Promise<void> {
    await this.ctx.globalState.update(RECENT_KEY, []);
    this.emitter.fire();
  }

  async removeConnection(id: string): Promise<void> {
    await this.ctx.globalState.update(FAV_KEY, this.favorites().filter((f) => f.connectionId !== id));
    await this.ctx.globalState.update(RECENT_KEY, this.recents().filter((f) => f.connectionId !== id));
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if ('group' in node) {
      const item = new vscode.TreeItem(node.group === 'favorites' ? 'Favorites' : 'Recent', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.group === 'favorites' ? 'star-full' : 'history');
      return item;
    }
    const profile = this.connections.get(node.connectionId);
    const item = collectionItem(node, `${profile?.name ?? '?'} · ${node.database}`, this.isPinned(node), profile);
    item.id = `${node.from}:${node.connectionId}/${node.database}/${node.collection}`;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const groups: Node[] = [];
      if (this.favorites().length) groups.push({ group: 'favorites' });
      if (this.recents().length) groups.push({ group: 'recent' });
      return groups;
    }
    if (!('group' in node)) return [];
    const list = node.group === 'favorites' ? this.favorites() : this.recents();
    return list.filter((r) => !!this.connections.get(r.connectionId)).map((r) => ({ ...r, kind: 'collection', from: node.group }));
  }
}
