import * as vscode from 'vscode';
import { parseDocumentText, ShellSyntaxError } from '../shared/shell';
import { docToShell, nodeToBson } from '../core/bsonCodec';
import { COLLECTION_METHODS, CURSOR_METHODS, DB_METHODS, QUERY_OPERATORS, UPDATE_OPERATORS, VALUE_HELPERS } from '../shared/operators';
import { sampleSchema } from '../core/operations';
import { flattenSchema } from '../core/schema';
import type { ConnectionManager } from './connections';
import type { PlaygroundController } from './playground';
import type { ExplorerProvider } from './tree';
import type { Document } from 'mongodb';

function completion(label: string, kind: vscode.CompletionItemKind, detail?: string, insert?: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, kind);
  item.detail = detail;
  if (insert) item.insertText = new vscode.SnippetString(insert);
  return item;
}

const operatorItems = () => [
  ...QUERY_OPERATORS.map(([op, doc]) => completion(op, vscode.CompletionItemKind.Operator, doc)),
  ...UPDATE_OPERATORS.map(([op, doc]) => completion(op, vscode.CompletionItemKind.Operator, doc)),
];

const helperItems = () => VALUE_HELPERS.map(([text, doc]) => {
  const i = completion(text.replace(/\(.*$/, ''), vscode.CompletionItemKind.Function, doc);
  const snippet = text.replace('""', '"$1"');
  i.insertText = new vscode.SnippetString(snippet);
  return i;
});

export function registerLanguageFeatures(connections: ConnectionManager, playground: PlaygroundController, explorer: ExplorerProvider): vscode.Disposable {
  const diag = vscode.languages.createDiagnosticCollection('mongodoc');

  const validate = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'mongodoc') return;
    const text = doc.getText();
    try {
      const node = parseDocumentText(text);
      if (node) nodeToBson(node, text);
      diag.delete(doc.uri);
    } catch (err) {
      if (err instanceof ShellSyntaxError) {
        const start = doc.positionAt(err.pos);
        const end = doc.positionAt(Math.max(err.end, err.pos + 1));
        diag.set(doc.uri, [new vscode.Diagnostic(new vscode.Range(start, end), err.message, vscode.DiagnosticSeverity.Error)]);
      }
    }
  };

  // Field names per collection, sampled once when first needed in a playground.
  const fieldCache = new Map<string, Promise<string[]>>();
  const fieldsFor = (connectionId: string, database: string, collection: string): Promise<string[]> => {
    const key = `${connectionId}/${database}/${collection}`;
    let p = fieldCache.get(key);
    if (!p) {
      p = connections.client(connectionId)
        .then((c) => sampleSchema(c.db(database).collection(collection), 100, { timeoutMs: 2000 }))
        .then((s) => flattenSchema(s.fields).map((f) => f.path))
        .catch(() => []);
      fieldCache.set(key, p);
      setTimeout(() => fieldCache.delete(key), 60000);
    }
    return p;
  };

  const subs: vscode.Disposable[] = [
    diag,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diag.delete(d.uri)),

    vscode.languages.registerDocumentFormattingEditProvider('mongodoc', {
      provideDocumentFormattingEdits(doc) {
        try {
          const text = doc.getText();
          const node = parseDocumentText(text);
          if (!node) return [];
          const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
          return [vscode.TextEdit.replace(whole, docToShell(nodeToBson(node, text) as Document) + '\n')];
        } catch {
          return [];
        }
      },
    }),

    vscode.languages.registerCompletionItemProvider('mongodoc', {
      provideCompletionItems: () => helperItems(),
    }),

    vscode.languages.registerCompletionItemProvider('mongoplayground', {
      async provideCompletionItems(doc, pos) {
        const before = doc.lineAt(pos.line).text.slice(0, pos.character);
        const target = playground.getTarget(doc);

        // db.<name> or db.<method>
        if (/\bdb\.[\w$]*$/.test(before)) {
          const items = DB_METHODS.map(([m, sig]) => completion(m, vscode.CompletionItemKind.Method, sig, `${m}($1)`));
          if (target) {
            const colls = await explorer.listCollections(target.connectionId, target.database).catch(() => []);
            for (const c of colls) {
              const item = completion(String(c.name), vscode.CompletionItemKind.Field, c.type === 'view' ? 'view' : 'collection');
              item.sortText = `0${c.name}`;
              items.push(item);
            }
          }
          return items;
        }
        // db.users.<method>
        if (/\bdb\.(?:[\w$]+|getCollection\([^)]*\))\.[\w$]*$/.test(before)) {
          return COLLECTION_METHODS.map(([m, sig]) => completion(m, vscode.CompletionItemKind.Method, sig, `${m}($1)`));
        }
        // db.users.find({...}).<method>
        if (/\)\s*\.[\w$]*$/.test(before)) {
          return CURSOR_METHODS.map(([m, sig]) => completion(m, vscode.CompletionItemKind.Method, sig, `${m}($1)`));
        }
        if (/\$[\w$]*$/.test(before)) return operatorItems();

        const items = helperItems();
        // Field names of the collection this statement is about.
        const textBefore = doc.getText(new vscode.Range(Math.max(0, pos.line - 15), 0, pos.line, pos.character));
        const calls = [...textBefore.matchAll(/\bdb\.(?:getCollection\(\s*["'`]([^"'`]+)["'`]\s*\)|([\w$]+))\.\w+\(/g)];
        const last = calls.at(-1);
        const name = last?.[1] ?? last?.[2];
        if (name && target) {
          const uses = [...doc.getText(new vscode.Range(0, 0, pos.line, 0)).matchAll(/^\s*use\(\s*["'`]([^"'`]+)/gm)];
          const database = uses.at(-1)?.[1] ?? target.database;
          for (const f of await fieldsFor(target.connectionId, database, name)) {
            const item = completion(f, vscode.CompletionItemKind.Field, `${name} field`);
            if (f.includes('.')) item.insertText = JSON.stringify(f);
            item.sortText = `0${f}`;
            items.push(item);
          }
        }
        return items;
      },
    }, '.', '$'),
  ];
  vscode.workspace.textDocuments.forEach(validate);
  return vscode.Disposable.from(...subs);
}
