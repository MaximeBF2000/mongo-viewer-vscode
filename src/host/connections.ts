import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Document } from 'mongodb';
import {
  firstHost, hostLabel, redact, rewriteForTunnel, sshArgs, type ConnectionProfile, type SshConfig,
} from '../core/connectionString';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnState {
  status: ConnStatus;
  error?: string;
  version?: string;
}

interface Live {
  client: MongoClient;
  tunnel?: Tunnel;
  uri: string;
}

const STORE_KEY = 'mongoViewer.connections';
const secretKey = (id: string) => `mongoViewer.uri.${id}`;

export const log = vscode.window.createOutputChannel('Mongo Viewer', { log: true });

export function friendlyError(err: unknown): string {
  const e = err as Error & { code?: unknown; cause?: Error };
  const raw = redact(e?.message ?? String(err));
  const name = e?.name ?? '';
  if (/Authentication failed|bad auth/i.test(raw)) return 'Authentication failed. Check the username, password and authSource.';
  if (/ENOTFOUND|querySrv|getaddrinfo/i.test(raw)) return `The host could not be found. ${raw}`;
  if (/ECONNREFUSED/i.test(raw)) return `The server refused the connection. Is MongoDB running? ${raw}`;
  if (/ETIMEDOUT|timed out/i.test(raw) || name === 'MongoServerSelectionError') return `Could not reach the server in time. Check the address, the network and any IP allow list. ${raw}`;
  if (/SSL|TLS|certificate/i.test(raw)) return `TLS connection failed: ${raw}`;
  return raw;
}

class Tunnel {
  private proc?: ChildProcess;
  localPort = 0;
  constructor(private ssh: SshConfig, private target: { host: string; port: number }) {}

  async start(): Promise<void> {
    this.localPort = await freePort();
    const args = sshArgs(this.ssh, this.localPort, this.target);
    log.info(`Opening SSH tunnel to ${this.target.host}:${this.target.port} through ${this.ssh.host}`);
    const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += String(d); });
    const failed = new Promise<never>((_, reject) => {
      proc.on('error', (e) => reject(new Error(`Could not run ssh: ${e.message}`)));
      proc.on('exit', (code) => reject(new Error(`The SSH tunnel closed (exit ${code}). ${stderr.trim()} Password prompts aren't supported: use a key or ssh-agent.`)));
    });
    await Promise.race([failed, waitForPort(this.localPort, 15000)]);
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the SSH tunnel to open.');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function connectTimeout(): number {
  return vscode.workspace.getConfiguration('mongoViewer').get('connectTimeoutMs', 8000);
}

export class ConnectionManager implements vscode.Disposable {
  private live = new Map<string, Live>();
  private states = new Map<string, ConnState>();
  private pending = new Map<string, Promise<MongoClient>>();
  private emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.ctx.globalState.get<ConnectionProfile[]>(STORE_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((c) => c.id === id);
  }

  state(id: string): ConnState {
    return this.states.get(id) ?? { status: 'disconnected' };
  }

  isConnected(id: string): boolean {
    const s = this.state(id).status;
    return s === 'connected' || s === 'reconnecting';
  }

  private setState(id: string, state: ConnState): void {
    this.states.set(id, state);
    this.emitter.fire(id);
  }

  /** The full connection string. Host-side only: never send it to a webview or a log. */
  async secretUri(id: string): Promise<string> {
    const uri = await this.ctx.secrets.get(secretKey(id));
    if (!uri) throw new Error('The saved connection string could not be read from secure storage. Edit the connection and enter it again.');
    return uri;
  }

  async save(profile: Omit<ConnectionProfile, 'id' | 'hostLabel'> & { id?: string }, uri: string): Promise<ConnectionProfile> {
    const id = profile.id ?? this.newId();
    const saved: ConnectionProfile = { ...profile, id, hostLabel: hostLabel(uri) };
    await this.ctx.secrets.store(secretKey(id), uri);
    const all = this.list();
    const idx = all.findIndex((c) => c.id === id);
    if (idx >= 0) all[idx] = saved;
    else all.push(saved);
    await this.ctx.globalState.update(STORE_KEY, all);
    this.emitter.fire(id);
    return saved;
  }

  /** Short, because connection ids appear in document URIs. */
  private newId(): string {
    const taken = new Set(this.list().map((c) => c.id));
    let id: string;
    do { id = randomUUID().slice(0, 8); } while (taken.has(id));
    return id;
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.ctx.secrets.delete(secretKey(id));
    await this.ctx.globalState.update(STORE_KEY, this.list().filter((c) => c.id !== id));
    this.states.delete(id);
    this.emitter.fire(undefined);
  }

  /** Returns a connected client, connecting first if needed. Reuses existing connections. */
  client(id: string): Promise<MongoClient> {
    const live = this.live.get(id);
    if (live) return Promise.resolve(live.client);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const p = this.open(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  private async open(id: string): Promise<MongoClient> {
    const profile = this.get(id);
    if (!profile) throw new Error('This connection no longer exists.');
    this.setState(id, { status: 'connecting' });
    let tunnel: Tunnel | undefined;
    try {
      let uri = await this.secretUri(id);
      if (profile.ssh) {
        tunnel = new Tunnel(profile.ssh, firstHost(uri));
        await tunnel.start();
        uri = rewriteForTunnel(uri, tunnel.localPort);
      }
      const client = new MongoClient(uri, {
        appName: 'mongo-viewer',
        serverSelectionTimeoutMS: connectTimeout(),
        connectTimeoutMS: Math.max(connectTimeout(), 10000),
      });
      await client.connect();
      const info: Document = await client.db('admin').command({ buildInfo: 1 }).catch(() => ({}));
      this.watch(id, client);
      this.live.set(id, { client, tunnel, uri });
      this.setState(id, { status: 'connected', version: info.version });
      log.info(`Connected to "${profile.name}" (${profile.hostLabel})${info.version ? `, MongoDB ${info.version}` : ''}`);
      return client;
    } catch (err) {
      tunnel?.stop();
      const message = friendlyError(err);
      log.error(`Could not connect to "${profile.name}": ${message}`);
      this.setState(id, { status: 'error', error: message });
      throw new Error(message);
    }
  }

  /** The driver reconnects by itself. This only reflects what it's doing in the UI. */
  private watch(id: string, client: MongoClient): void {
    client.on('topologyDescriptionChanged', (e) => {
      const current = this.states.get(id);
      if (!this.live.has(id) || !current) return;
      const reachable = [...e.newDescription.servers.values()].some((s) => s.type !== 'Unknown');
      if (!reachable && current.status === 'connected') {
        log.warn(`Lost contact with "${this.get(id)?.name}". Reconnecting automatically.`);
        this.setState(id, { ...current, status: 'reconnecting' });
      } else if (reachable && current.status === 'reconnecting') {
        log.info(`Reconnected to "${this.get(id)?.name}".`);
        this.setState(id, { ...current, status: 'connected' });
      }
    });
  }

  async disconnect(id: string): Promise<void> {
    const live = this.live.get(id);
    this.live.delete(id);
    if (live) {
      await live.client.close().catch(() => undefined);
      live.tunnel?.stop();
    }
    this.setState(id, { status: 'disconnected' });
  }

  async reconnect(id: string): Promise<MongoClient> {
    await this.disconnect(id);
    return this.client(id);
  }

  /** The URI other processes should use. It goes through the SSH tunnel when there is one. */
  async effectiveUri(id: string): Promise<string> {
    await this.client(id);
    return this.live.get(id)!.uri;
  }

  /** Tries a connection without saving anything. */
  async test(uri: string, ssh?: SshConfig): Promise<string> {
    let tunnel: Tunnel | undefined;
    let client: MongoClient | undefined;
    try {
      let target = uri;
      if (ssh) {
        tunnel = new Tunnel(ssh, firstHost(uri));
        await tunnel.start();
        target = rewriteForTunnel(uri, tunnel.localPort);
      }
      client = new MongoClient(target, { appName: 'mongo-viewer', serverSelectionTimeoutMS: connectTimeout() });
      await client.connect();
      const info = await client.db('admin').command({ buildInfo: 1 }).catch(() => undefined);
      await client.db('admin').command({ ping: 1 });
      return info?.version ? `Connected to MongoDB ${info.version}.` : 'Connected.';
    } finally {
      await client?.close().catch(() => undefined);
      tunnel?.stop();
    }
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) void this.disconnect(id);
    this.emitter.dispose();
  }
}

/** A write may only proceed once this returns: blocks read-only, confirms production. */
export async function confirmWrite(profile: ConnectionProfile, action: string): Promise<boolean> {
  if (profile.readOnly) {
    void vscode.window.showWarningMessage(`"${profile.name}" is read-only, so ${action} isn't allowed.`);
    return false;
  }
  if (profile.environment !== 'production') return true;
  if (!vscode.workspace.getConfiguration('mongoViewer').get('confirmProductionWrites', true)) return true;
  const ok = await vscode.window.showWarningMessage(
    `This writes to PRODUCTION: ${profile.name}`,
    { modal: true, detail: `Action: ${action}` },
    'Continue',
  );
  return ok === 'Continue';
}

/** Modal confirmation for destructive actions. */
export async function confirmDestructive(message: string, detail: string, button: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
}
