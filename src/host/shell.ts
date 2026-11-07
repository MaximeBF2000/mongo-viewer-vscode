import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { friendlyError, type ConnectionManager } from './connections';

const COMMON_PATHS = ['/opt/homebrew/bin/mongosh', '/usr/local/bin/mongosh', '/usr/bin/mongosh'];

function findMongosh(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('mongoViewer').get<string>('mongoshPath', '').trim();
  if (configured) return Promise.resolve(existsSync(configured) ? configured : undefined);
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, ['mongosh'], (err, stdout) => {
      const found = stdout?.split(/\r?\n/)[0]?.trim();
      if (!err && found) resolve(found);
      else resolve(COMMON_PATHS.find((p) => existsSync(p)));
    });
  });
}

/**
 * Opens the official mongosh in an integrated terminal. The connection string reaches
 * it through the process environment, read by a small init script that deletes it at
 * once. It never appears in the command line, shell history or terminal text. The
 * terminal runs mongosh directly, with no intermediate shell.
 */
export class ShellLauncher implements vscode.Disposable {
  private terminals = new Map<string, vscode.Terminal>();
  private closeSub: vscode.Disposable;

  constructor(private ctx: vscode.ExtensionContext, private connections: ConnectionManager) {
    this.closeSub = vscode.window.onDidCloseTerminal((t) => {
      for (const [k, v] of this.terminals) if (v === t) this.terminals.delete(k);
    });
  }

  async open(connectionId: string, database?: string): Promise<void> {
    const key = `${connectionId}/${database ?? ''}`;
    const existing = this.terminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const profile = this.connections.get(connectionId);
    if (!profile) return;
    const mongosh = await findMongosh();
    if (!mongosh) {
      const choice = await vscode.window.showErrorMessage(
        'mongosh was not found. Install the MongoDB Shell, or set its path in "mongoViewer.mongoshPath".',
        'Install Instructions', 'Open Settings',
      );
      if (choice === 'Install Instructions') await vscode.env.openExternal(vscode.Uri.parse('https://www.mongodb.com/docs/mongodb-shell/install/'));
      if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'mongoViewer.mongoshPath');
      return;
    }
    let uri: string;
    try {
      uri = await this.connections.effectiveUri(connectionId);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open mongosh: ${friendlyError(err)}`);
      return;
    }
    const initScript = join(this.ctx.extensionPath, 'media', 'mongosh-init.js');
    const isProd = profile.environment === 'production';
    const terminal = vscode.window.createTerminal({
      name: `mongosh: ${profile.name}${database ? ` / ${database}` : ''}`,
      shellPath: mongosh,
      shellArgs: ['--nodb', '--shell', '--quiet', initScript],
      env: { MONGO_VIEWER_URI: uri, MONGO_VIEWER_DB: database ?? '' },
      color: isProd ? new vscode.ThemeColor('terminal.ansiRed') : undefined,
      iconPath: new vscode.ThemeIcon('database'),
      // Transient terminals aren't persisted, so the environment is never saved to disk.
      isTransient: true,
    });
    this.terminals.set(key, terminal);
    terminal.show();
    if (isProd) void vscode.window.showWarningMessage(`This mongosh terminal is connected to PRODUCTION: ${profile.name}`);
    else if (profile.readOnly) void vscode.window.showWarningMessage(`"${profile.name}" is marked read-only here, but mongosh is a full shell, so that isn't enforced in the terminal.`);
  }

  dispose(): void {
    this.closeSub.dispose();
  }
}
