// Documents open as real VS Code text editors on a virtual file system. Save, undo,
// dirty state, diff and all editor features work natively, and saving writes to MongoDB.
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ObjectId, type Collection, type Document } from 'mongodb';
import { confirmDestructive, confirmWrite, friendlyError, log, type ConnectionManager } from './connections';
import { docToShell, encodeId, decodeId, FIDELITY_READ, fingerprint, parseEditableDocument } from '../core/bsonCodec';
import { ShellSyntaxError } from '../shared/shell';

export const DOC_SCHEME = 'mongoviewer-doc';

export interface CollRef { connectionId: string; database: string; collection: string; type?: string }

interface Entry {
  mtime: number;
  ctime: number;
  size: number;
  baseline?: string;
  /** Text of an unsaved new or duplicated document. */
  draft?: string;
}

const encoder = new TextEncoder();

function labelForId(id: unknown): string {
  const text = (id as { toHexString?: () => string })?.toHexString?.() ?? (typeof id === 'object' ? encodeId(id) : String(id));
  return text.replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 60) || 'document';
}

function buildUri(ref: CollRef, label: string, query: Record<string, string>): vscode.Uri {
  return vscode.Uri.from({
    scheme: DOC_SCHEME,
    authority: ref.connectionId,
    path: `/${encodeURIComponent(ref.database)}/${encodeURIComponent(ref.collection)}/${label}.mongodoc`,
    query: new URLSearchParams(query).toString(),
  });
}

function parseUri(uri: vscode.Uri): { ref: CollRef; id?: unknown; isNew: boolean; readOnly: boolean; revision: boolean } {
  const [, db, coll] = uri.path.split('/');
  const q = new URLSearchParams(uri.query);
  const idText = q.get('id');
  // ObjectIds live in the file name, which keeps URIs (and VS Code's save errors) short.
  const hexId = !q.has('new') && uri.path.match(/\/([0-9a-f]{24})\.mongodoc$/)?.[1];
  return {
    ref: { connectionId: uri.authority, database: decodeURIComponent(db), collection: decodeURIComponent(coll) },
    id: idText ? decodeId(idText) : hexId ? new ObjectId(hexId) : undefined,
    isNew: q.has('new'),
    readOnly: q.get('ro') === '1' || q.has('rev'),
    revision: q.has('rev'),
  };
}

export class DocumentFs implements vscode.FileSystemProvider {
  private entries = new Map<string, Entry>();
  private fileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.fileEmitter.event;
  private collEmitter = new vscode.EventEmitter<string>();
  /** Fires with "connection/db/collection" after a document changes. */
  readonly onDidChangeCollection = this.collEmitter.event;

  constructor(private connections: ConnectionManager) {}

  private key(uri: vscode.Uri): string {
    return uri.toString();
  }

  private async coll(ref: CollRef): Promise<Collection> {
    const client = await this.connections.client(ref.connectionId);
    return client.db(ref.database).collection(ref.collection);
  }

  private collKey(ref: CollRef): string {
    return `${ref.connectionId}/${ref.database}/${ref.collection}`;
  }

  async openDocument(ref: CollRef, id: unknown, writable: boolean): Promise<void> {
    const query: Record<string, string> = id instanceof ObjectId ? {} : { id: encodeId(id) };
    if (!writable) query.ro = '1';
    const uri = buildUri(ref, labelForId(id), query);
    await this.show(uri);
  }

  async openNewDocument(ref: CollRef, draft = '{\n  \n}\n'): Promise<void> {
    const uri = buildUri(ref, 'New Document', { new: randomUUID().slice(0, 8) });
    this.entries.set(this.key(uri), { mtime: Date.now(), ctime: Date.now(), size: draft.length, draft });
    const editor = await this.show(uri);
    if (draft.startsWith('{\n  \n')) {
      const pos = new vscode.Position(1, 2);
      editor.selection = new vscode.Selection(pos, pos);
    }
  }

  async openDuplicate(ref: CollRef, id: unknown): Promise<void> {
    const doc = await (await this.coll(ref)).findOne({ _id: id } as Document, FIDELITY_READ);
    if (!doc) throw new Error('This document no longer exists.');
    const { _id, ...rest } = doc;
    await this.openNewDocument(ref, docToShell(rest) + '\n');
  }

  private async show(uri: vscode.Uri): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'mongodoc') await vscode.languages.setTextDocumentLanguage(doc, 'mongodoc');
    return vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Called after a panel edits a field, so clean editors reload their text. */
  notifyDocumentChanged(ref: CollRef, encodedId?: string): void {
    const now = Date.now();
    const events: vscode.FileChangeEvent[] = [];
    for (const [key, entry] of this.entries) {
      const uri = vscode.Uri.parse(key);
      const parsed = parseUri(uri);
      if (this.collKey(parsed.ref) !== this.collKey(ref) || parsed.isNew || parsed.revision) continue;
      if (encodedId && encodeId(parsed.id) !== encodedId) continue;
      entry.mtime = now;
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length) this.fileEmitter.fire(events);
  }

  // FileSystemProvider ------------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const parts = uri.path.split('/').filter(Boolean);
    if (parts.length < 3) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const { readOnly, ref } = parseUri(uri);
    const entry = this.entries.get(this.key(uri));
    const blocked = readOnly || !!this.connections.get(ref.connectionId)?.readOnly;
    return {
      type: vscode.FileType.File,
      ctime: entry?.ctime ?? 0,
      mtime: entry?.mtime ?? 0,
      // Size is deliberately constant. VS Code only needs mtime to spot changes.
      size: entry?.size ?? 0,
      permissions: blocked ? vscode.FilePermission.Readonly : undefined,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = this.key(uri);
    const existing = this.entries.get(key);
    if (existing?.draft !== undefined) return encoder.encode(existing.draft);
    const parsed = parseUri(uri);
    if (parsed.id === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    const coll = await this.coll(parsed.ref);
    const doc = await coll.findOne({ _id: parsed.id } as Document, FIDELITY_READ);
    if (!doc) throw vscode.FileSystemError.FileNotFound('This document no longer exists in the database.');
    const text = docToShell(doc) + '\n';
    const bytes = encoder.encode(text);
    this.entries.set(key, {
      mtime: existing?.mtime ?? Date.now(),
      ctime: existing?.ctime ?? Date.now(),
      size: bytes.length,
      baseline: parsed.revision ? undefined : fingerprint(doc),
    });
    return bytes;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const parsed = parseUri(uri);
    const profile = this.connections.get(parsed.ref.connectionId);
    if (!profile) throw vscode.FileSystemError.Unavailable('This connection no longer exists.');
    if (parsed.readOnly || profile.readOnly) throw vscode.FileSystemError.NoPermissions('This document is read-only.');
    const text = new TextDecoder().decode(content);
    let doc: Document;
    try {
      doc = parseEditableDocument(text);
    } catch (err) {
      const e = err as Error;
      const where = err instanceof ShellSyntaxError ? ` (line ${err.line}, column ${err.col})` : '';
      throw vscode.FileSystemError.Unavailable(`Not saved. ${e.message}${where}`);
    }
    try {
      if (parsed.isNew) await this.insert(uri, parsed.ref, doc);
      else await this.replace(uri, parsed.ref, parsed.id, doc);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) throw err;
      throw vscode.FileSystemError.Unavailable(`Not saved. ${friendlyError(err)}`);
    }
    this.collEmitter.fire(this.collKey(parsed.ref));
  }

  private async insert(uri: vscode.Uri, ref: CollRef, doc: Document): Promise<void> {
    const profile = this.connections.get(ref.connectionId)!;
    if (!(await confirmWrite(profile, `insert a document into ${ref.collection}`))) throw vscode.FileSystemError.NoPermissions('Not saved. The write was cancelled.');
    const coll = await this.coll(ref);
    const res = await coll.insertOne(doc);
    log.info(`Inserted a document into ${ref.database}.${ref.collection}`);
    vscode.window.setStatusBarMessage('$(check) Document inserted', 3000);
    this.entries.delete(this.key(uri));
    this.entries.set(this.key(uri), { mtime: Date.now(), ctime: Date.now(), size: 0, draft: docToShell({ ...doc, _id: res.insertedId }) + '\n' });
    // The tab now represents the saved document, so swap it once the save has finished.
    setTimeout(() => void this.swapToSaved(uri, ref, res.insertedId), 50);
  }

  private async swapToSaved(uri: vscode.Uri, ref: CollRef, id: unknown): Promise<void> {
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    if (tab) await vscode.window.tabGroups.close(tab, true);
    this.entries.delete(this.key(uri));
    await this.openDocument(ref, id, true);
  }

  private async replace(uri: vscode.Uri, ref: CollRef, id: unknown, doc: Document): Promise<void> {
    const key = this.key(uri);
    const coll = await this.coll(ref);
    if (!Object.prototype.hasOwnProperty.call(doc, '_id')) doc = { _id: id, ...doc };
    if (encodeId(doc._id) !== encodeId(id)) {
      throw vscode.FileSystemError.NoPermissions('Not saved. The _id of a document cannot be changed. Duplicate it to create a copy with a new _id.');
    }
    const current = await coll.findOne({ _id: id } as Document, FIDELITY_READ);
    if (!current) throw vscode.FileSystemError.FileNotFound('Not saved. This document was deleted from the database. Duplicate your text into a new document to keep it.');
    const entry = this.entries.get(key);
    if (entry?.baseline && fingerprint(current) !== entry.baseline) {
      const choice = await vscode.window.showWarningMessage(
        'This document changed in the database after you opened it.',
        { modal: true, detail: 'Saving now would overwrite those changes.' },
        'Compare',
        'Overwrite',
      );
      if (choice === 'Compare') {
        // The user is now looking at this version, so a second save overwrites it knowingly.
        if (entry) entry.baseline = fingerprint(current);
        await this.compareWithDatabase(uri);
        throw vscode.FileSystemError.Unavailable('Not saved. Review the differences, then save again to overwrite.');
      }
      if (choice !== 'Overwrite') throw vscode.FileSystemError.Unavailable('Not saved. The document changed in the database.');
    }
    if (!(await confirmWrite(this.connections.get(ref.connectionId)!, `save this document in ${ref.collection}`))) {
      throw vscode.FileSystemError.NoPermissions('Not saved. The write was cancelled.');
    }
    await coll.replaceOne({ _id: id } as Document, doc);
    const saved = await coll.findOne({ _id: id } as Document, FIDELITY_READ);
    this.entries.set(key, { mtime: Date.now(), ctime: entry?.ctime ?? Date.now(), size: 0, baseline: saved ? fingerprint(saved) : undefined });
    log.info(`Saved a document in ${ref.database}.${ref.collection}`);
    vscode.window.setStatusBarMessage('$(check) Document saved', 3000);
  }

  createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }
  delete(): void { throw vscode.FileSystemError.NoPermissions(); }

  // Commands ---------------------------------------------------------------

  /** Opens the database version next to the editor's version. */
  async compareWithDatabase(uri: vscode.Uri): Promise<void> {
    const parsed = parseUri(uri);
    if (parsed.id === undefined) {
      void vscode.window.showInformationMessage('This document has not been saved yet.');
      return;
    }
    const query = new URLSearchParams(uri.query);
    query.set('rev', String(Date.now()));
    const left = uri.with({ query: query.toString() });
    const title = `${uri.path.split('/').pop()?.replace('.mongodoc', '')}: Database ↔ Editor`;
    await vscode.commands.executeCommand('vscode.diff', left, uri, title);
  }

  async deleteOpen(uri: vscode.Uri): Promise<void> {
    const parsed = parseUri(uri);
    const profile = this.connections.get(parsed.ref.connectionId);
    if (!profile || parsed.id === undefined) return;
    if (!(await confirmDestructive('Delete this document?', `From ${parsed.ref.database}.${parsed.ref.collection}. This can't be undone.`, 'Delete'))) return;
    if (!(await confirmWrite(profile, 'delete a document'))) return;
    try {
      await (await this.coll(parsed.ref)).deleteOne({ _id: parsed.id } as Document);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not delete: ${friendlyError(err)}`);
      return;
    }
    vscode.window.setStatusBarMessage('$(check) Document deleted', 3000);
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    if (tab) await vscode.window.tabGroups.close(tab, true);
    this.entries.delete(this.key(uri));
    this.collEmitter.fire(this.collKey(parsed.ref));
  }

  async duplicateOpen(uri: vscode.Uri): Promise<void> {
    const parsed = parseUri(uri);
    if (parsed.id === undefined) return;
    await this.openDuplicate(parsed.ref, parsed.id);
  }
}
