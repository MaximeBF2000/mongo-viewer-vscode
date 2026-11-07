import * as vscode from 'vscode';
import { friendlyError, type ConnectionManager } from './connections';
import { renderHtml, serveRpc, webviewOptions, type Handlers } from './webview';
import {
  findUrisInEnv, getUsername, guessEnvironment, redact, splitPassword, validateUri, withPassword,
  type ConnectionProfile, type Environment, type SshConfig,
} from '../core/connectionString';
import type { ConnectionFormApi, ConnectionFormData } from '../shared/protocol';

function sshFromForm(f: ConnectionFormData): SshConfig | undefined {
  if (!f.sshEnabled || !f.sshHost.trim()) return undefined;
  return {
    host: f.sshHost.trim(),
    port: f.sshPort.trim() ? Number(f.sshPort) : undefined,
    user: f.sshUser.trim() || undefined,
    identityFile: f.sshIdentityFile.trim() || undefined,
  };
}

/** Finds connection strings in .env files. Asks the user to choose: nothing is imported silently. */
export async function pickUriFromEnv(): Promise<{ uri: string; name: string } | undefined> {
  const found = await vscode.workspace.findFiles('**/.env*', '**/node_modules/**', 40);
  const items: (vscode.QuickPickItem & { uri?: string; browse?: boolean })[] = [];
  for (const file of found) {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    for (const c of findUrisInEnv(text)) {
      items.push({ label: c.key, description: redact(c.uri), detail: vscode.workspace.asRelativePath(file), uri: c.uri });
    }
  }
  items.push({ label: '$(file) Choose a file…', browse: true });
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Import Connection from .env File',
    placeHolder: items.length > 1 ? 'Choose the connection string to import' : 'No connection strings found in this workspace',
  });
  if (!pick) return undefined;
  if (pick.browse) {
    const files = await vscode.window.showOpenDialog({ title: 'Choose a .env file', canSelectMany: false, openLabel: 'Read File' });
    if (!files?.[0]) return undefined;
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0]));
    const candidates = findUrisInEnv(text);
    if (!candidates.length) {
      void vscode.window.showWarningMessage('No MongoDB connection strings were found in that file.');
      return undefined;
    }
    const chosen = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: c.key, description: redact(c.uri), uri: c.uri })),
      { title: 'Choose the connection string to import' },
    );
    return chosen ? { uri: chosen.uri, name: chosen.label } : undefined;
  }
  return { uri: pick.uri!, name: pick.label };
}

const nameFromKey = (key: string) =>
  key.replace(/_?(MONGO(DB)?|URI|URL|CONNECTION|STRING|DATABASE|DB)_?/gi, ' ').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || key;

export class ConnectionForms {
  private open = new Map<string, vscode.WebviewPanel>();

  constructor(private ctx: vscode.ExtensionContext, private connections: ConnectionManager, private afterSave: (p: ConnectionProfile, connect: boolean) => void) {}

  async show(existing?: ConnectionProfile, prefill?: { uri: string; name: string }): Promise<void> {
    const key = existing?.id ?? 'new';
    const current = this.open.get(key);
    if (current && !prefill) {
      current.reveal();
      return;
    }
    current?.dispose();
    const panel = vscode.window.createWebviewPanel(
      'mongoViewer.connectionForm',
      existing ? `Edit ${existing.name}` : 'New Connection',
      vscode.ViewColumn.Active,
      webviewOptions(this.ctx.extensionUri),
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'file.svg');
    this.open.set(key, panel);
    panel.webview.html = renderHtml(panel.webview, this.ctx.extensionUri, 'connectionForm', panel.title);
    const prefillSplit = prefill ? splitPassword(prefill.uri) : undefined;
    const handlers: Handlers<ConnectionFormApi> = {
      load: async () => {
        let uri = prefillSplit?.uri ?? '';
        let hasSavedPassword = false;
        if (existing) {
          const split = splitPassword(await this.connections.secretUri(existing.id));
          uri = split.uri;
          hasSavedPassword = !!split.password;
        }
        return {
          id: existing?.id,
          name: existing?.name ?? (prefill ? nameFromKey(prefill.name) : ''),
          uri,
          // The password stays host-side. An empty field means "keep the saved one".
          password: prefillSplit?.password ?? '',
          hasSavedPassword,
          environment: existing?.environment ?? (prefill ? guessEnvironment(prefill.name, prefill.uri) : 'none'),
          color: existing?.color ?? '',
          readOnly: existing?.readOnly ?? false,
          sshEnabled: !!existing?.ssh,
          sshHost: existing?.ssh?.host ?? '',
          sshPort: existing?.ssh?.port ? String(existing.ssh.port) : '',
          sshUser: existing?.ssh?.user ?? '',
          sshIdentityFile: existing?.ssh?.identityFile ?? '',
        };
      },
      test: async (form) => {
        const uri = await this.buildUri(form, existing);
        const problem = validateUri(uri);
        if (problem) return { ok: false, message: problem };
        try {
          return { ok: true, message: await this.connections.test(uri, sshFromForm(form)) };
        } catch (err) {
          return { ok: false, message: friendlyError(err) };
        }
      },
      save: async ({ form, connect }) => {
        const uri = await this.buildUri(form, existing);
        const problem = validateUri(uri);
        if (problem) return { ok: false, message: problem };
        if (!form.name.trim()) return { ok: false, message: 'Give this connection a name.' };
        const saved = await this.connections.save({
          id: existing?.id,
          name: form.name.trim(),
          environment: form.environment as Environment,
          color: form.color || undefined,
          readOnly: form.readOnly,
          ssh: sshFromForm(form),
        }, uri);
        if (existing) await this.connections.disconnect(existing.id);
        panel.dispose();
        this.afterSave(saved, connect);
        return { ok: true };
      },
      cancel: () => panel.dispose(),
      browseFile: async () => {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Choose a file' });
        return files?.[0]?.fsPath ?? null;
      },
      importEnv: async () => {
        const res = await pickUriFromEnv();
        if (!res) return null;
        const split = splitPassword(res.uri);
        return { uri: split.uri, password: split.password, name: nameFromKey(res.name) };
      },
      guessEnvironment: ({ name, uri }) => guessEnvironment(name, uri),
    };
    const rpc = serveRpc<ConnectionFormApi>(panel.webview, handlers, 'connectionForm');
    panel.onDidDispose(() => {
      rpc.dispose();
      this.open.delete(key);
    });
  }

  /** Merges form fields. A password typed in the URI wins, then the field, then the saved one. */
  private async buildUri(form: ConnectionFormData, existing?: ConnectionProfile): Promise<string> {
    const typed = form.uri.trim();
    if (validateUri(typed)) return typed;
    const split = splitPassword(typed);
    if (split.password) return typed;
    if (form.password) return getUsername(typed) ? withPassword(typed, form.password) : typed;
    if (existing && getUsername(typed)) {
      const saved = splitPassword(await this.connections.secretUri(existing.id));
      if (saved.password && getUsername(saved.uri) === getUsername(typed)) return withPassword(typed, saved.password);
    }
    return typed;
  }
}
