// Connection string helpers. Nothing here touches VS Code, so it can be unit tested.
import ConnectionString from 'mongodb-connection-string-url';

export type Environment = 'none' | 'local' | 'development' | 'staging' | 'production';

export interface SshConfig {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
}

/** Saved metadata. Never holds credentials: the full URI lives in SecretStorage. */
export interface ConnectionProfile {
  id: string;
  name: string;
  /** Host list without credentials, for display. */
  hostLabel: string;
  environment: Environment;
  color?: string;
  readOnly: boolean;
  ssh?: SshConfig;
}

export function validateUri(uri: string): string | null {
  const t = uri.trim();
  if (!t) return 'Enter a connection string.';
  if (!/^mongodb(\+srv)?:\/\//.test(t)) return 'A connection string starts with mongodb:// or mongodb+srv://.';
  try {
    new ConnectionString(t);
    return null;
  } catch (err) {
    return redact((err as Error).message);
  }
}

export function hostLabel(uri: string): string {
  try {
    return new ConnectionString(uri).hosts.join(', ');
  } catch {
    return 'unknown host';
  }
}

export function defaultDatabase(uri: string): string | undefined {
  try {
    const p = new ConnectionString(uri).pathname.replace(/^\//, '');
    return p ? decodeURIComponent(p) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a URI into its password-free form and its password. */
export function splitPassword(uri: string): { uri: string; password: string } {
  try {
    const cs = new ConnectionString(uri);
    const password = decodeURIComponent(cs.password);
    cs.password = '';
    return { uri: cs.toString(), password };
  } catch {
    return { uri, password: '' };
  }
}

export function withPassword(uri: string, password: string): string {
  if (!password) return uri;
  const cs = new ConnectionString(uri);
  cs.password = encodeURIComponent(password);
  return cs.toString();
}

export function getUsername(uri: string): string {
  try {
    return decodeURIComponent(new ConnectionString(uri).username);
  } catch {
    return '';
  }
}

/** Removes credentials from any text: URIs in messages, password parameters, and so on. */
export function redact(text: string): string {
  return text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s'"]+@/g, '$1<credentials>@')
    .replace(/((?:password|pwd|authMechanismProperties|tlsCertificateKeyFilePassword)=)[^&\s'"]+/gi, '$1<redacted>');
}

export function guessEnvironment(name: string, uri: string): Environment {
  const hay = `${name} ${uri.replace(/:\/\/[^@/]*@/, '://')}`.toLowerCase();
  if (/\bprod(uction)?\b|[-_.]prod[-_.]/.test(hay)) return 'production';
  if (/\b(stag(e|ing)|preprod|uat)\b/.test(hay)) return 'staging';
  if (/\bdev(elopment)?\b/.test(hay)) return 'development';
  if (/localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal/.test(hay)) return 'local';
  return 'none';
}

export interface EnvCandidate { key: string; uri: string }

/** Finds MongoDB connection strings in the text of a .env file. Nothing is executed or expanded. */
export function findUrisInEnv(text: string): EnvCandidate[] {
  const out: EnvCandidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      const close = value.indexOf(q, 1);
      if (close > 0) value = value.slice(1, close);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (/^mongodb(\+srv)?:\/\//.test(value) && !validateUri(value)) out.push({ key: m[1], uri: value });
  }
  return out;
}

/** Rewrites a URI to go through a local SSH forward. */
export function rewriteForTunnel(uri: string, localPort: number): string {
  const cs = new ConnectionString(uri);
  cs.hosts = [`127.0.0.1:${localPort}`];
  const params = cs.searchParams as unknown as URLSearchParams;
  params.set('directConnection', 'true');
  params.delete('replicaSet');
  return cs.toString();
}

export function firstHost(uri: string): { host: string; port: number } {
  const cs = new ConnectionString(uri);
  if (cs.isSRV) throw new Error('SSH tunnels need a mongodb:// connection string. mongodb+srv:// hosts must be resolved first.');
  const entry = cs.hosts[0];
  const v6 = entry.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2] ?? 27017) };
  const [host, port] = entry.split(':');
  return { host, port: Number(port ?? 27017) };
}

/** Arguments for `ssh` that forward a local port. BatchMode means it never prompts inside the extension. */
export function sshArgs(ssh: SshConfig, localPort: number, target: { host: string; port: number }): string[] {
  const args = [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${localPort}:${target.host}:${target.port}`,
  ];
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  args.push(ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host);
  return args;
}
